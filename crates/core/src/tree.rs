//! Version 3 project graph. Parent IDs and names are authoritative; paths are views.
use crate::valid_path;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub binary: bool,
    #[serde(default)]
    pub folder: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Command {
    Inspect,
    Migrate,
    Normalize,
    Add { entries: Vec<Node> },
    Restore { entries: Vec<Node> },
    Relocate { id: String, path: String },
    Delete { id: String },
}
#[derive(Deserialize)]
pub struct Request {
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub reserved: Vec<String>,
    #[serde(flatten)]
    pub command: Command,
}
fn name_valid(name: &str) -> bool {
    valid_path(name) && !name.contains('/')
}
fn collision_key(path: &str) -> String {
    path.nfc().flat_map(char::to_lowercase).collect()
}
fn check_ids(nodes: &[Node]) -> Result<(), String> {
    let mut ids = HashSet::new();
    for node in nodes {
        if node.id.is_empty() || !ids.insert(&node.id) {
            return Err("Project contains duplicate or empty file IDs.".into());
        }
    }
    Ok(())
}

/// Every node remains visible even when independent valid moves form a cycle after merge.
/// Conflicts are a projection: never silently rename or delete the underlying graph.
fn inspect(nodes: &[Node]) -> Vec<Node> {
    let by_id: HashMap<_, _> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut result = Vec::with_capacity(nodes.len());
    for source in nodes {
        let mut node = source.clone();
        node.conflict = None;
        let mut current = source;
        let mut seen = HashSet::new();
        let mut parts = Vec::new();
        loop {
            if !seen.insert(current.id.as_str()) {
                node.conflict =
                    Some("Folder cycle. Move an affected folder to the project root.".into());
                break;
            }
            let name = current.name.as_deref().unwrap_or(&current.path);
            if !name_valid(name) {
                node.conflict = Some("Invalid file or folder name. Rename this item.".into());
                break;
            }
            parts.push(name);
            match current.parent_id.as_deref() {
                None => break,
                Some(id) => match by_id.get(id) {
                    Some(parent) if parent.folder => current = parent,
                    Some(_) => {
                        node.conflict =
                            Some("Parent is a file. Move this item into a folder.".into());
                        break;
                    }
                    None => {
                        node.conflict = Some(
                            "Parent folder is missing. Move this item into an existing folder."
                                .into(),
                        );
                        break;
                    }
                },
            }
        }
        parts.reverse();
        node.path = parts.join("/");
        if node.path.is_empty() {
            node.path = source.name.clone().unwrap_or_else(|| source.path.clone());
        }
        if node.conflict.is_none() && !valid_path(&node.path) {
            node.conflict = Some("Path exceeds 240 UTF-8 bytes. Move or rename this item.".into());
        }
        if node.folder && node.binary {
            node.conflict = Some("Folders cannot contain binary data.".into());
        }
        result.push(node);
    }
    let mut counts: HashMap<String, usize> = HashMap::new();
    for node in &result {
        *counts.entry(collision_key(&node.path)).or_default() += 1;
    }
    for node in &mut result {
        if node.conflict.is_none() && counts[&collision_key(&node.path)] > 1 {
            node.conflict = Some("A file or folder with this path already exists, including case or Unicode variants. Rename one of the marked items.".into());
        }
    }
    result.sort_by(|a, b| a.path.cmp(&b.path).then(a.id.cmp(&b.id)));
    result
}

fn fresh_folder_id(path: &str, nodes: &[Node], reserved: &[String]) -> String {
    let mut id = format!("folder:{path}");
    while nodes.iter().any(|n| n.id == id) || reserved.contains(&id) {
        id.push('~');
    }
    id
}

/// Bridge legacy path records and incoming ZIP entries into the parent-based graph.
fn prepare(mut nodes: Vec<Node>, reserved: &[String]) -> Result<Vec<Node>, String> {
    check_ids(&nodes)?;
    if nodes.iter().all(|n| n.name.is_some()) {
        return Ok(nodes);
    }
    let paths: HashMap<String, String> = inspect(
        &nodes
            .iter()
            .filter(|n| n.name.is_some())
            .cloned()
            .collect::<Vec<_>>(),
    )
    .into_iter()
    .map(|n| (n.id, n.path))
    .collect();
    let mut by_path: HashMap<String, Vec<String>> = HashMap::new();
    for node in &nodes {
        let path = if node.name.is_none() {
            &node.path
        } else {
            &paths[&node.id]
        };
        if node.name.is_none() && !valid_path(path) {
            return Err(format!("Invalid project path: {path}"));
        }
        by_path
            .entry(path.clone())
            .or_default()
            .push(node.id.clone());
    }
    let legacy: Vec<_> = nodes
        .iter()
        .filter(|n| n.name.is_none())
        .map(|n| (n.id.clone(), n.path.clone()))
        .collect();
    for (id, path) in legacy {
        let parts: Vec<_> = path.split('/').collect();
        let mut parent = None;
        for depth in 1..parts.len() {
            let prefix = parts[..depth].join("/");
            let folder_id = match by_path.get(&prefix) {
                Some(ids) if ids.len() == 1 => {
                    let node = nodes.iter().find(|n| n.id == ids[0]).unwrap();
                    if !node.folder {
                        return Err(format!(
                            "{prefix} is a file, so it cannot contain other files."
                        ));
                    }
                    node.id.clone()
                }
                Some(_) => {
                    return Err(format!(
                        "Ambiguous parent folder: {prefix}. Resolve its name conflicts first."
                    ));
                }
                None => {
                    let folder_id = fresh_folder_id(&prefix, &nodes, reserved);
                    nodes.push(Node {
                        id: folder_id.clone(),
                        name: Some(parts[depth - 1].into()),
                        parent_id: parent.clone(),
                        folder: true,
                        ..Default::default()
                    });
                    by_path.insert(prefix, vec![folder_id.clone()]);
                    folder_id
                }
            };
            parent = Some(folder_id);
        }
        let node = nodes.iter_mut().find(|n| n.id == id).unwrap();
        node.name = Some(parts.last().unwrap().to_string());
        node.parent_id = parent;
    }
    Ok(nodes)
}
fn conflict_error(nodes: &[Node]) -> Option<String> {
    nodes
        .iter()
        .find_map(|n| n.conflict.as_ref().map(|why| format!("{}: {why}", n.path)))
}
fn check_limits(before: &[Node], after: &[Node]) -> Result<(), String> {
    let files = |nodes: &[Node]| nodes.iter().filter(|n| !n.folder).count();
    if (after.len() > 1024 && after.len() >= before.len())
        || (files(after) > 512 && files(after) >= files(before))
    {
        return Err("Projects support up to 512 files and 1024 total tree entries.".into());
    }
    Ok(())
}
pub fn execute(request: Request) -> Result<Vec<Node>, String> {
    let mut nodes = prepare(request.nodes, &request.reserved)?;
    let before = inspect(&nodes);
    let mut allowed_conflicts = before.clone();
    match request.command {
        Command::Inspect | Command::Migrate => return Ok(before),
        Command::Normalize => {
            if let Some(error) = conflict_error(&before) {
                return Err(error);
            }
            check_limits(&[], &before)?;
            return Ok(before);
        }
        Command::Add { entries } => {
            nodes.extend(entries);
            nodes = prepare(nodes, &request.reserved)?;
        }
        Command::Restore { entries } => {
            // A deleted conflicted graph may be restored for repair, but never overwrite live IDs.
            allowed_conflicts.extend(inspect(&prepare(entries.clone(), &request.reserved)?));
            nodes.extend(entries);
            nodes = prepare(nodes, &request.reserved)?;
        }
        Command::Relocate { id, path } => {
            if !valid_path(&path) {
                return Err("Use a relative project path of at most 240 UTF-8 bytes.".into());
            }
            if !nodes.iter().any(|n| n.id == id) {
                return Err("File or folder no longer exists.".into());
            }
            // Resolve the destination using a temporary file. Only missing folders are retained.
            let mut probe_id = "destination-probe".to_string();
            while nodes.iter().any(|n| n.id == probe_id) {
                probe_id.push('~');
            }
            let mut probe_nodes = nodes.clone();
            probe_nodes.push(Node {
                id: probe_id.clone(),
                path: path.clone(),
                ..Default::default()
            });
            let prepared = prepare(probe_nodes, &request.reserved)?;
            let target = prepared.iter().find(|n| n.id == probe_id).unwrap();
            let parent = target.parent_id.clone();
            let name = target.name.clone();
            let existing: HashSet<_> = nodes.iter().map(|n| n.id.clone()).collect();
            nodes.extend(
                prepared
                    .into_iter()
                    .filter(|n| n.id != probe_id && !existing.contains(&n.id)),
            );
            let node = nodes.iter_mut().find(|n| n.id == id).unwrap();
            node.parent_id = parent;
            node.name = name;
        }
        Command::Delete { id } => {
            let original = nodes
                .iter()
                .find(|n| n.id == id)
                .ok_or("File or folder no longer exists.")?;
            let mut removed = HashSet::from([id]);
            if original.folder {
                loop {
                    let previous = removed.len();
                    for node in &nodes {
                        if node
                            .parent_id
                            .as_ref()
                            .is_some_and(|parent| removed.contains(parent))
                        {
                            removed.insert(node.id.clone());
                        }
                    }
                    if removed.len() == previous {
                        break;
                    }
                }
            }
            nodes.retain(|n| !removed.contains(&n.id));
        }
    }
    check_ids(&nodes)?;
    let result = inspect(&nodes);
    check_limits(&before, &result)?;
    // Existing independent conflicts must not prevent repairing one item at a time.
    for node in &result {
        if let Some(why) = &node.conflict {
            if !allowed_conflicts
                .iter()
                .any(|old| old.id == node.id && old.conflict.as_ref() == Some(why))
            {
                return Err(format!("{}: {why}", node.path));
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn file(id: &str, path: &str) -> Node {
        Node {
            id: id.into(),
            path: path.into(),
            ..Default::default()
        }
    }
    fn run(nodes: Vec<Node>, command: Command) -> Result<Vec<Node>, String> {
        execute(Request {
            nodes,
            command,
            reserved: vec![],
        })
    }
    fn migrate(nodes: Vec<Node>) -> Vec<Node> {
        run(nodes, Command::Migrate).unwrap()
    }
    #[test]
    fn migration_preserves_names_ids_and_is_idempotent() {
        let nodes = migrate(vec![file("paper", "a/b/été.tex")]);
        assert_eq!(nodes.len(), 3);
        assert_eq!(migrate(nodes.clone()), nodes);
        assert_eq!(nodes[2].id, "paper");
        assert_eq!(nodes[2].parent_id.as_deref(), Some("folder:a/b"));
    }
    #[test]
    fn moving_a_parent_changes_only_its_record() {
        let nodes = migrate(vec![file("paper", "a/b/main.tex")]);
        let original = nodes.iter().find(|n| n.id == "paper").unwrap().clone();
        let result = run(
            nodes,
            Command::Relocate {
                id: "folder:a".into(),
                path: "chapters".into(),
            },
        )
        .unwrap();
        let moved = result.iter().find(|n| n.id == "paper").unwrap();
        assert_eq!(moved.parent_id, original.parent_id);
        assert_eq!(moved.name, original.name);
        assert_eq!(moved.path, "chapters/b/main.tex");
    }
    #[test]
    fn rejects_cycles_collision_variants_and_descendant_overflow() {
        let nodes = migrate(vec![file("a", "a/p.tex"), file("b", "b/p.tex")]);
        for path in ["b", "a/nested", &"x".repeat(238)] {
            assert!(
                run(
                    nodes.clone(),
                    Command::Relocate {
                        id: "folder:a".into(),
                        path: path.into()
                    }
                )
                .is_err()
            );
        }
        for path in ["A/p.tex", "a/P.tex"] {
            assert!(
                run(
                    nodes.clone(),
                    Command::Add {
                        entries: vec![file("new", path)]
                    }
                )
                .is_err()
            );
        }
        assert!(
            run(
                migrate(vec![file("a", "café.tex")]),
                Command::Add {
                    entries: vec![file("b", "cafe\u{301}.tex")]
                }
            )
            .is_err()
        );
    }
    #[test]
    fn concurrent_cycles_stay_visible_and_can_be_repaired() {
        let mut nodes = migrate(vec![file("a", "a/p.tex"), file("b", "b/p.tex")]);
        nodes
            .iter_mut()
            .find(|n| n.id == "folder:a")
            .unwrap()
            .parent_id = Some("folder:b".into());
        nodes
            .iter_mut()
            .find(|n| n.id == "folder:b")
            .unwrap()
            .parent_id = Some("folder:a".into());
        let view = run(nodes.clone(), Command::Inspect).unwrap();
        assert_eq!(view.len(), 4);
        assert!(view.iter().all(|n| n.conflict.is_some()));
        let fixed = run(
            nodes,
            Command::Relocate {
                id: "folder:a".into(),
                path: "recovered".into(),
            },
        )
        .unwrap();
        assert!(fixed.iter().all(|n| n.conflict.is_none()));
    }
    #[test]
    fn missing_parent_and_multiple_name_conflicts_can_be_fixed_independently() {
        let mut nodes = migrate(vec![
            file("a", "same.tex"),
            file("b", "same.tex"),
            file("c", "other.tex"),
            file("d", "other.tex"),
        ]);
        nodes.push(Node {
            id: "orphan".into(),
            name: Some("orphan.tex".into()),
            parent_id: Some("deleted".into()),
            ..Default::default()
        });
        let nodes = run(
            nodes,
            Command::Relocate {
                id: "a".into(),
                path: "first.tex".into(),
            },
        )
        .unwrap();
        let nodes = run(
            nodes,
            Command::Relocate {
                id: "c".into(),
                path: "second.tex".into(),
            },
        )
        .unwrap();
        let nodes = run(
            nodes,
            Command::Relocate {
                id: "orphan".into(),
                path: "orphan.tex".into(),
            },
        )
        .unwrap();
        assert!(nodes.iter().all(|n| n.conflict.is_none()));
    }
    #[test]
    fn deletion_uses_parent_identity_not_path_prefixes() {
        let nodes = migrate(vec![file("a", "a/p.tex"), file("b", "ab/p.tex")]);
        let result = run(
            nodes,
            Command::Delete {
                id: "folder:a".into(),
            },
        )
        .unwrap();
        assert_eq!(result.len(), 2);
        assert!(result.iter().any(|n| n.id == "b"));
    }
}
