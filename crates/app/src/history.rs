use leptos::prelude::*;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn history_validate_manifest(encoded: &str) -> Result<(), JsValue> {
    scribyra_core::history::manifest(encoded)
        .map(|_| ())
        .map_err(|e| JsValue::from_str(&e))
}
#[wasm_bindgen]
pub fn history_validate_backup(encoded: &str) -> Result<(), JsValue> {
    scribyra_core::history::backup_manifest(encoded)
        .map(|_| ())
        .map_err(|e| JsValue::from_str(&e))
}
#[wasm_bindgen]
pub fn history_diff(before: &str, after: &str) -> Result<String, JsValue> {
    let parse = |s| serde_json::from_str(s).map_err(|e| JsValue::from_str(&format!("{e}")));
    Ok(scribyra_core::history::diff(parse(before)?, parse(after)?).to_string())
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct State {
    enabled: bool,
    open: bool,
    busy: bool,
    source_export: bool,
    status: String,
    status_tone: String,
    copied_project: String,
    filter: String,
    selected: String,
    focus_ref: String,
    groups: Vec<Group>,
    details: HashMap<String, Detail>,
    version: Version,
    compare: String,
    diff_loading: bool,
    diff_message: String,
    files: Vec<FileRow>,
    others: Vec<String>,
    selected_file: String,
    file_diff: Option<FileDiff>,
    dialog: String,
    dialog_error: String,
    plan: Plan,
    manage_open: bool,
    list_open: bool,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Group {
    key: String,
    label: String,
    entries: Vec<Entry>,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Entry {
    r#ref: String,
    time: String,
    label: String,
    tag: String,
    available: bool,
    status: String,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Detail {
    summary: String,
    authors: Vec<Author>,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Author {
    id: String,
    name: String,
    initials: String,
    tone: String,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Version {
    r#ref: String,
    current: bool,
    title: String,
    meta: String,
    available: bool,
    status: String,
    named: bool,
    pinned: bool,
    version_id: String,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct FileRow {
    file_id: String,
    path: String,
    from_path: String,
    status: String,
    binary: bool,
    large: bool,
    additions: String,
    deletions: String,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct FileDiff {
    file_id: String,
    path: String,
    from_path: String,
    status: String,
    additions: String,
    deletions: String,
    rows: Vec<Row>,
    notice: String,
    message: String,
    binary: bool,
    can_download_before: bool,
    can_download_after: bool,
    asset: Option<AssetView>,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Row {
    kind: String,
    old_line: String,
    new_line: String,
    label: String,
    segments: Vec<Segment>,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Segment {
    text: String,
    changed: bool,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct AssetView {
    image: bool,
    before_url: String,
    after_url: String,
    before_size: String,
    after_size: String,
    change: String,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Plan {
    kind: String,
    title: String,
    intro: String,
    confirm: String,
    list_title: String,
    files: Vec<PlanFile>,
    notes: Vec<String>,
    keep: Vec<PlanVersion>,
    remove: Vec<PlanVersion>,
    technical: Vec<Technical>,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PlanFile {
    path: String,
    status: String,
    description: String,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PlanVersion {
    id: String,
    when: String,
    name: String,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Technical {
    label: String,
    values: String,
}

fn status_word(status: &str) -> &'static str {
    match status {
        "added" => "Added",
        "deleted" => "Deleted",
        "renamed" => "Renamed",
        _ => "Edited",
    }
}
fn status_letter(status: &str) -> &'static str {
    match status {
        "added" => "A",
        "deleted" => "D",
        "renamed" => "R",
        _ => "E",
    }
}
fn marker(status: &str) -> AnyView {
    view! { <span class=format!("history-marker {status}") title=status_word(status) aria-hidden="true">{status_letter(status)}</span> }.into_any()
}
fn split_path(path: &str) -> (String, String) {
    match path.rfind('/') {
        Some(index) => (path[..=index].to_string(), path[index + 1..].to_string()),
        None => (String::new(), path.to_string()),
    }
}
fn authors_view(authors: &[Author]) -> AnyView {
    authors
        .iter()
        .map(|author| {
            view! { <span class=format!("history-author tone-{}", author.tone) title=author.name.clone() aria-hidden="true">{author.initials.clone()}</span> }
        })
        .collect_view()
        .into_any()
}

/// The top-bar control. It stays small so the toolbar can place it anywhere; the view itself mounts in the workspace.
#[component]
pub fn History(state: Signal<State>) -> impl IntoView {
    view! {
        <Show when=move || state.get().enabled>
            <div class="history-feature">
                <button class="button secondary compact" title="Project history" aria-expanded=move || state.get().open.to_string() aria-controls="project-history" on:click=move |_| crate::action("history-toggle", "")>"History"</button>
            </div>
        </Show>
    }
}

#[component]
pub fn HistoryView(state: Signal<State>) -> impl IntoView {
    let st = Memo::new(move |_| state.get());
    view! {
        <Show when=move || st.with(|s| s.enabled && s.open)>
            <Workspace st=st/>
        </Show>
    }
}

#[component]
fn Workspace(st: Memo<State>) -> impl IntoView {
    let back = NodeRef::<leptos::html::Button>::new();
    Effect::new(move |_| {
        if let Some(button) = back.get() {
            let _ = button.focus();
        }
    });
    view! {
        <section id="project-history" class="history-view" aria-label="Project history" data-list-open=move || st.with(|s| s.list_open.to_string())>
            <div class="history-main">
                <header class="history-bar">
                    <button node_ref=back class="history-btn ghost history-back" on:click=move |_| crate::action("history-toggle", "")><crate::Icon name="back"/>"Back to editor"</button>
                    <span class="history-bar-divider" aria-hidden="true"></span>
                    <SelectedVersion st=st/>
                    <button class="history-btn secondary history-list-toggle" aria-expanded=move || st.with(|s| s.list_open.to_string()) aria-controls="history-version-column" on:click=move |_| crate::action("history-list", "")>"Versions"</button>
                </header>
                <Show when=move || st.with(|s| !s.version.available)>
                    <p class="history-unavailable">
                        <strong>"Not available on this device."</strong>
                        " The saved data for this version is missing or damaged here, so it can’t be viewed or restored. A complete backup that contains it can bring it back."
                    </p>
                </Show>
                <Show when=move || st.with(|s| s.version.available) fallback=|| ()>
                    <div class="history-compare-area" data-files=move || st.with(|s| (!s.files.is_empty() || !s.others.is_empty() || s.diff_loading).to_string())>
                        <Show when=move || st.with(|s| !s.files.is_empty() || !s.others.is_empty() || s.diff_loading)>
                            <ChangedFiles st=st/>
                        </Show>
                        <DiffViewer st=st/>
                    </div>
                </Show>
            </div>
            <VersionColumn st=st/>
            <footer class="history-footer" data-tone=move || st.with(|s| s.status_tone.clone())>
                <p role="status" aria-label="History status">{move || st.with(|s| s.status.clone())}</p>
                <Show when=move || st.with(|s| s.source_export)>
                    <button class="history-btn secondary" disabled=move || st.with(|s| s.busy) on:click=move |_| crate::action("export", "")>"Export source ZIP"</button>
                </Show>
                <Show when=move || st.with(|s| !s.copied_project.is_empty())>
                    <button class="history-btn secondary" on:click=move |_| { let id = st.with_untracked(|s| s.copied_project.clone()); crate::action("open", &id); }>"Open the new project"</button>
                </Show>
            </footer>
            <Show when=move || st.with(|s| !s.dialog.is_empty())>
                <HistoryDialog st=st/>
            </Show>
        </section>
    }
}

#[component]
fn SelectedVersion(st: Memo<State>) -> impl IntoView {
    let selected = move || st.with(|s| s.version.r#ref.clone());
    view! {
        <div class="history-selected">
            <h2>{move || st.with(|s| s.version.title.clone())}</h2>
            <p class="history-selected-meta">
                <span>{move || st.with(|s| s.version.meta.clone())}</span>
                <Show when=move || st.with(|s| !s.version.current && s.version.available)>
                    <span class="history-restorable">{move || st.with(|s| s.version.status.clone())}</span>
                </Show>
                <Show when=move || st.with(|s| !s.version.available)>
                    <span class="history-not-restorable">{move || st.with(|s| s.version.status.clone())}</span>
                </Show>
                <span class="history-authors">{move || st.with(|s| s.details.get(&s.version.r#ref).map(|d| authors_view(&d.authors)))}</span>
                <span class="history-byline">{move || st.with(|s| s.details.get(&s.version.r#ref).map(|d| d.authors.iter().map(|a| a.name.clone()).collect::<Vec<_>>().join(", ")))}</span>
            </p>
        </div>
        <div class="history-actions">
            <Show when=move || st.with(|s| s.version.current)>
                <button class="history-btn primary" disabled=move || st.with(|s| s.busy) on:click=move |_| crate::action("history-name-open", "")>"Name this version"</button>
            </Show>
            <Show when=move || st.with(|s| !s.version.current && s.version.available)>
                <Show when=move || st.with(|s| s.version.named && s.version.pinned)>
                    <button class="history-btn ghost" title="Let Clean up history remove this version" disabled=move || st.with(|s| s.busy) on:click=move |_| { let id = st.with_untracked(|s| s.version.version_id.clone()); crate::action("history-unpin", &id); }>"Allow clean-up"</button>
                </Show>
                <button class="history-btn secondary" disabled=move || st.with(|s| s.busy) on:click=move |_| crate::action("history-current", &selected())>"Restore into this project"</button>
                <button class="history-btn primary" disabled=move || st.with(|s| s.busy) on:click=move |_| crate::action("history-copy", &selected())>"Restore as a copy"</button>
            </Show>
        </div>
    }
}

#[component]
fn VersionColumn(st: Memo<State>) -> impl IntoView {
    let selected = Memo::new(move |_| st.with(|s| s.selected.clone()));
    let is_empty = move || st.with(|s| s.groups.is_empty());
    view! {
        <div class="history-backdrop" on:click=move |_| crate::action("history-list", "")></div>
        <aside class="history-column" id="history-version-column" aria-label="Versions">
            <div class="history-column-head">
                <h2>"Versions"</h2>
                <div class="history-manage">
                    <button class="history-btn ghost small history-manage-toggle" aria-label="Manage history" aria-expanded=move || st.with(|s| s.manage_open.to_string()) on:click=move |_| crate::action("history-manage", "")>"Manage"</button>
                    <Show when=move || st.with(|s| s.manage_open)>
                        <div class="history-manage-panel" role="group" aria-label="Manage history">
                            <button disabled=move || st.with(|s| s.busy) on:click=move |_| crate::action("history-export", "")>"Export complete backup"</button>
                            <button disabled=move || st.with(|s| s.busy) on:click=move |_| crate::action("history-import", "")>"Import complete backup"</button>
                            <p>"A backup includes deleted content and isn’t encrypted, so keep it somewhere private."</p>
                            <hr/>
                            <button disabled=move || st.with(|s| s.busy) on:click=move |_| crate::action("history-compact", "")>"Clean up history"</button>
                            <p>"Free up space by removing versions you don’t need. You’ll see exactly what goes first."</p>
                        </div>
                    </Show>
                </div>
            </div>
            <div class="history-filter" role="group" aria-label="Show versions">
                <button aria-pressed=move || st.with(|s| (s.filter != "named").to_string()) on:click=move |_| crate::action("history-filter", "all")>"All changes"</button>
                <button aria-pressed=move || st.with(|s| (s.filter == "named").to_string()) on:click=move |_| crate::action("history-filter", "named")>"Named versions"</button>
            </div>
            <Show when=is_empty fallback=move || view! {
                <div class="history-versions" role="listbox" aria-label="Versions, newest first">
                    <For each=move || st.with(|s| s.groups.clone()) key=|g| g.key.clone() children=move |group| {
                        let key = group.key.clone();
                        view! {
                            <div class="history-day" role="group" aria-label=group.label.clone()>
                                <div class="history-day-label" aria-hidden="true">{group.label.clone()}</div>
                                <For each=move || st.with(|s| s.groups.iter().find(|g| g.key == key).map(|g| g.entries.clone()).unwrap_or_default())
                                    key=|e| (e.r#ref.clone(), e.label.clone(), e.available, e.status.clone(), e.tag.clone(), e.time.clone())
                                    children=move |entry| view! { <VersionEntry entry=entry st=st selected=selected/> }/>
                            </div>
                        }
                    }/>
                </div>
            }>
                <div class="history-empty-list">
                    <p>"Name a version to keep it easy to find and safe from clean-up."</p>
                    <button class="history-btn primary" disabled=move || st.with(|s| s.busy) on:click=move |_| crate::action("history-name-open", "")>"Name this version"</button>
                </div>
            </Show>
        </aside>
    }
}

#[component]
fn VersionEntry(entry: Entry, st: Memo<State>, selected: Memo<String>) -> impl IntoView {
    let r#ref = entry.r#ref.clone();
    let summary = {
        let r#ref = r#ref.clone();
        move || st.with(|s| s.details.get(&r#ref).map(|d| d.summary.clone()).unwrap_or_default())
    };
    let detail_authors = {
        let r#ref = r#ref.clone();
        move || st.with(|s| s.details.get(&r#ref).map(|d| authors_view(&d.authors)))
    };
    let author_names = {
        let r#ref = r#ref.clone();
        move || st.with(|s| s.details.get(&r#ref).map(|d| d.authors.iter().map(|a| a.name.clone()).collect::<Vec<_>>().join(", ")).unwrap_or_default())
    };
    let is_selected = {
        let r#ref = r#ref.clone();
        move || selected.with(|value| *value == r#ref)
    };
    let focus = {
        let r#ref = r#ref.clone();
        move || st.with(|s| s.focus_ref == r#ref)
    };
    let select = r#ref.clone();
    let has_label = !entry.label.is_empty();
    let has_tag = !entry.tag.is_empty();
    let selected_class = is_selected.clone();
    view! {
        <button class=move || if selected_class() { "history-entry selected" } else { "history-entry" } role="option" data-ref=r#ref.clone()
            aria-selected=move || is_selected().to_string() tabindex=move || if focus() { "0" } else { "-1" }
            on:click=move |_| crate::action("history-select", &select)>
            <Show when=move || has_label><span class="history-name-tag">{entry.label.clone()}</span></Show>
            <span class="history-entry-top">
                <span class="history-entry-time">{entry.time.clone()}</span>
                <Show when=move || has_tag><span class="history-entry-tag">{entry.tag.clone()}</span></Show>
                <span class="history-authors">{detail_authors}</span>
            </span>
            <span class="sr-only">{move || { let names = author_names(); if names.is_empty() { String::new() } else { format!("By {names}. ") } }}</span>
            {if entry.available {
                view! { <span class="history-entry-summary">{summary}</span> }.into_any()
            } else {
                view! { <span class="history-entry-summary warn">{entry.status.clone()}</span> }.into_any()
            }}
        </button>
    }
}

#[component]
fn ChangedFiles(st: Memo<State>) -> impl IntoView {
    let count = move || {
        st.with(|s| match s.files.len() {
            0 => "No files changed".to_string(),
            1 => "1 file changed".to_string(),
            n => format!("{n} files changed"),
        })
    };
    view! {
        <nav class="history-files" aria-label="Files changed">
            <h3>{count}</h3>
            <ul>
                <For each=move || st.with(|s| s.files.clone()) key=|f| (f.file_id.clone(), f.path.clone(), f.status.clone()) children=move |file| {
                    let (dir, name) = split_path(&file.path);
                    let detail = if file.from_path.is_empty() { dir.trim_end_matches('/').to_string() } else { format!("from {}", file.from_path) };
                    let has_detail = !detail.is_empty();
                    let id = file.file_id.clone();
                    let current = file.file_id.clone();
                    let word = status_word(&file.status);
                    let title = if file.from_path.is_empty() { format!("{}: {}", word, file.path) } else { format!("{}: {} to {}", word, file.from_path, file.path) };
                    let (added, removed) = (file.additions.clone(), file.deletions.clone());
                    let show_counts = !file.binary && !file.large;
                    view! {
                        <li><button class="history-file" title=title aria-current=move || st.with(|s| if s.selected_file == current { Some("true") } else { None }) on:click=move |_| crate::action("history-file", &id)>
                            {marker(&file.status)}
                            <span class="sr-only">{word}": "</span>
                            <span class="history-file-path"><span class="name">{name}</span>{has_detail.then(|| view! { <span class="dir">{detail.clone()}</span> })}</span>
                            {show_counts.then(|| counts_view(&added, &removed))}
                        </button></li>
                    }
                }/>
            </ul>
            <Show when=move || st.with(|s| !s.others.is_empty())>
                <ul class="history-others">
                    <For each=move || st.with(|s| s.others.clone()) key=|o| o.clone() children=|other| view! { <li>{other}</li> }/>
                </ul>
            </Show>
        </nav>
    }
}

#[component]
fn DiffViewer(st: Memo<State>) -> impl IntoView {
    let file = Memo::new(move |_| st.with(|s| s.file_diff.clone()));
    view! {
        <section class="history-diff" aria-label="Changes" aria-busy=move || st.with(|s| s.diff_loading.to_string())>
            <div class="history-diff-head" hidden=move || st.with(|s| s.version.current && s.file_diff.is_none())>
                <div class="history-diff-title">
                    {move || file.with(|f| f.as_ref().map(diff_title))}
                </div>
                <Show when=move || st.with(|s| !s.version.current)>
                    <div class="history-compare" role="group" aria-label="Compare">
                        <button aria-pressed=move || st.with(|s| (s.compare != "current").to_string()) on:click=move |_| crate::action("history-compare", "previous")>"In this version"</button>
                        <button aria-pressed=move || st.with(|s| (s.compare == "current").to_string()) on:click=move |_| crate::action("history-compare", "current")>"Since this version"</button>
                    </div>
                </Show>
            </div>
            <div class="history-diff-scroll" role="region" tabindex="0" aria-label="History diff">
                {move || {
                    if let Some(message) = st.with(|s| (!s.diff_message.is_empty()).then(|| s.diff_message.clone())) {
                        return view! { <p class="history-diff-note" role="alert">{message}</p> }.into_any();
                    }
                    file.with(|f| match f {
                        None => {
                            let loading = st.with(|s| s.diff_loading);
                            view! { <p class="history-diff-note">{if loading { "Loading changes…" } else if st.with_untracked(|s| !s.others.is_empty()) { "No files changed. Only comments, reviews or settings did." } else if st.with_untracked(|s| s.version.current) { "Nothing has changed yet. Name this version to find it again easily." } else { "No files changed in this comparison." }}</p> }.into_any()
                        }
                        Some(f) => file_body(f),
                    })
                }}
            </div>
        </section>
    }
}

fn counts_view(added: &str, removed: &str) -> AnyView {
    let add = (added != "0").then(|| view! { <span class="add">"+"{added.to_string()}</span> });
    let del = (removed != "0").then(|| view! { <span class="del">"−"{removed.to_string()}</span> });
    view! { <span class="history-file-counts">{add}{del}</span> }.into_any()
}

fn diff_title(f: &FileDiff) -> AnyView {
    let renamed = (!f.from_path.is_empty()).then(|| {
        view! { <span class="history-renamed-from" title=f.from_path.clone()>"renamed from "{f.from_path.clone()}</span> }
    });
    let counts = (!f.binary).then(|| counts_view(&f.additions, &f.deletions));
    view! {
        {marker(&f.status)}
        <span class="sr-only">{status_word(&f.status)}": "</span>
        <strong title=f.path.clone()>{f.path.clone()}</strong>
        {renamed}
        {counts}
    }
    .into_any()
}

fn file_body(file: &FileDiff) -> AnyView {
    let message = (!file.message.is_empty()).then(|| view! { <p class="history-diff-note">{file.message.clone()}</p> });
    let notice = (!file.notice.is_empty()).then(|| {
        let before = file.can_download_before;
        let after = file.can_download_after;
        view! {
            <div class="history-truncated" role="note">
                <p><strong>"Not the whole change."</strong>" "{file.notice.clone()}</p>
                <div class="history-downloads">
                    {before.then(|| view! { <button class="history-btn secondary small" on:click=|_| crate::action("history-download", "before")>"Download earlier file"</button> })}
                    {after.then(|| view! { <button class="history-btn secondary small" on:click=|_| crate::action("history-download", "after")>"Download later file"</button> })}
                </div>
            </div>
        }
    });
    let asset = file.asset.as_ref().map(|asset| asset_view(&file.path, asset));
    let rows = (!file.rows.is_empty()).then(|| {
        view! {
            <table class="history-lines" aria-label=format!("Changes in {}", file.path)>
                                <thead class="sr-only"><tr><th scope="col">"Earlier line"</th><th scope="col">"Later line"</th><th scope="col">"Text"</th></tr></thead>
                <tbody>{file.rows.iter().map(row_view).collect_view()}</tbody>
            </table>
        }
    });
    view! { {notice}{message}{asset}{rows} }.into_any()
}

fn row_view(row: &Row) -> AnyView {
    if row.kind == "gap" {
        return view! { <tr class="gap"><td colspan="3">{row.label.clone()}</td></tr> }.into_any();
    }
    let word = match row.kind.as_str() {
        "add" => "Added: ",
        "delete" => "Deleted: ",
        _ => "",
    };
    let kind = row.kind.clone();
    let whole = row.segments.len() == 1 && row.segments[0].changed;
    let segments = row
        .segments
        .iter()
        .map(|segment| match (kind.as_str(), segment.changed) {
            ("add", true) => view! { <ins>{segment.text.clone()}</ins> }.into_any(),
            ("delete", true) => view! { <del>{segment.text.clone()}</del> }.into_any(),
            _ => view! { <span>{segment.text.clone()}</span> }.into_any(),
        })
        .collect_view();
    view! {
        <tr class=format!("{}{}", row.kind, if whole { " whole" } else { "" })>
            <td class="num">{row.old_line.clone()}</td>
            <td class="num">{row.new_line.clone()}</td>
            <td class="code"><span class="sr-only">{word}</span>{segments}</td>
        </tr>
    }
    .into_any()
}

fn asset_view(path: &str, asset: &AssetView) -> AnyView {
    let side = |label: &'static str, url: &str, size: &str, tone: &'static str| {
        let alt = format!("{label} image: {path}");
        let which = tone;
        let download = (!size.is_empty()).then(|| view! {
            <button class="history-asset-download" aria-label=format!("Download {} file", label.to_lowercase()) title="Download" on:click=move |_| crate::action("history-download", which)><crate::Icon name="download"/></button>
        });
        let has_image = asset.image && !url.is_empty();
        let empty = if size.is_empty() { Some(view! { <p class="history-asset-empty">{if which == "before" { "Didn’t exist yet" } else { "Deleted" }}</p> }) } else { None };
        let no_preview = (!asset.image && !size.is_empty()).then(|| view! { <p class="history-asset-empty">"No preview for this type of file. Use the download button to open it."</p> });
        view! {
            <figure class=format!("history-asset-side {tone}")>
                <figcaption><span class="side">{label}</span><span class="size">{size.to_string()}</span>{download}</figcaption>
                {has_image.then(|| view! { <div class="history-asset-frame"><img src=url.to_string() alt=alt.clone()/></div> })}
                {empty}
                {no_preview}
            </figure>
        }
    };
    let summary = asset.change.clone();
    view! {
        <section class="history-asset" aria-label=format!("Asset comparison {path}")>
            <div class="history-asset-sides">
                {side("Earlier", &asset.before_url, &asset.before_size, "before")}
                {side("Later", &asset.after_url, &asset.after_size, "after")}
            </div>
            <Show when={let show = !summary.is_empty(); move || show}><p class="history-asset-change">{summary.clone()}</p></Show>
        </section>
    }
    .into_any()
}

#[component]
fn HistoryDialog(st: Memo<State>) -> impl IntoView {
    let dialog = NodeRef::<leptos::html::Dialog>::new();
    Effect::new(move |_| {
        if let Some(element) = dialog.get() {
            if !element.open() {
                let _ = element.show_modal();
            }
        }
    });
    let is_name = move || st.with(|s| s.dialog == "name");
    view! {
        <dialog node_ref=dialog class="modal history-dialog" aria-labelledby="history-dialog-title"
            on:cancel=move |event: web_sys::Event| { event.prevent_default(); crate::action("history-cancel-plan", ""); }>
            <Show when=is_name fallback=move || view! { <PlanBody st=st/> }>
                <NameBody st=st/>
            </Show>
        </dialog>
    }
}

#[component]
fn NameBody(st: Memo<State>) -> impl IntoView {
    let (empty, set_empty) = signal(true);
    view! {
        <form on:submit=move |event| { event.prevent_default(); if !empty.get_untracked() && !crate::composing() { crate::action("history-name", ""); } }>
            <h2 id="history-dialog-title">"Name this version"</h2>
            <p>"Saves the project as it is now under a name, so it’s easy to find and kept during clean-up."</p>
            <label class="history-field">"Version name"
                <input autofocus maxlength="160" autocomplete="off" on:input=move |event| {
                    let value = event_target_value(&event);
                    set_empty.set(value.trim().is_empty());
                    crate::action("history-label", &value);
                }/>
            </label>
            <DialogError st=st/>
            <div class="modal-actions">
                <button type="button" class="history-btn secondary" on:click=move |_| crate::action("history-cancel-plan", "")>"Cancel"</button>
                <button type="submit" class="history-btn primary" disabled=move || empty.get() || st.with(|s| s.busy)>"Save version name"</button>
            </div>
        </form>
    }
}

#[component]
fn DialogError(st: Memo<State>) -> impl IntoView {
    view! {
        <Show when=move || st.with(|s| !s.dialog_error.is_empty())>
            <p class="history-dialog-error" role="alert">{move || st.with(|s| s.dialog_error.clone())}</p>
        </Show>
    }
}

fn version_rows(rows: &[PlanVersion]) -> AnyView {
    if rows.is_empty() {
        return view! { <p class="history-plan-none">"None"</p> }.into_any();
    }
    view! {
        <ul>{rows.iter().map(|row| view! { <li title=row.id.clone()><span>{row.when.clone()}</span><span class="name">{row.name.clone()}</span></li> }).collect_view()}</ul>
    }
    .into_any()
}

#[component]
fn PlanBody(st: Memo<State>) -> impl IntoView {
    let plan = Memo::new(move |_| st.with(|s| s.plan.clone()));
    view! {
        {move || {
            let plan = plan.get();
            let compact = plan.kind == "compact";
            let wide = compact || !plan.files.is_empty();
            let keep_title = format!("Kept ({})", plan.keep.len());
            let remove_title = format!("Removed ({})", plan.remove.len());
            let kept = version_rows(&plan.keep);
            let removed = version_rows(&plan.remove);
            let columns = compact.then(move || view! {
                <div class="history-plan-columns">
                    <section aria-label="Versions kept"><h3>{keep_title}</h3>{kept}</section>
                    <section aria-label="Versions removed"><h3>{remove_title}</h3>{removed}</section>
                </div>
            });
            view! {
                <div class:history-dialog-wide=wide>
                    <h2 id="history-dialog-title">{plan.title.clone()}</h2>
                    <p>{plan.intro.clone()}</p>
                    {(!plan.list_title.is_empty()).then(|| view! { <h3>{plan.list_title.clone()}</h3> })}
                    {(!plan.files.is_empty()).then(|| view! {
                        <ul class="history-plan-files">
                            {plan.files.iter().map(|file| view! {
                                <li>{marker(&file.status)}<span class="path" title=file.path.clone()>{file.path.clone()}</span><span class="what">{file.description.clone()}</span></li>
                            }).collect_view()}
                        </ul>
                    })}
                    {columns}
                    {plan.notes.iter().map(|note| view! { <p class="history-plan-note">{note.clone()}</p> }).collect_view()}
                    {(!plan.technical.is_empty()).then(|| view! {
                        <details class="history-plan-technical">
                            <summary>"Exact list of what’s kept and removed"</summary>
                            <dl>{plan.technical.iter().map(|row| view! { <dt>{row.label.clone()}</dt><dd>{row.values.clone()}</dd> }).collect_view()}</dl>
                        </details>
                    })}
                </div>
            }
        }}
        <DialogError st=st/>
        <div class="modal-actions">
            <button autofocus class="history-btn secondary" disabled=move || st.with(|s| s.busy) on:click=move |_| crate::action("history-cancel-plan", "")>"Cancel"</button>
            <button class=move || plan.with(|p| if p.kind == "compact" && !p.remove.is_empty() { "history-btn danger" } else { "history-btn primary" }) disabled=move || st.with(|s| s.busy) on:click=move |_| crate::action("history-apply", "")>{move || plan.with(|p| p.confirm.clone())}</button>
        </div>
    }
}

#[wasm_bindgen]
pub fn history_restore_plan(
    before: &str,
    after: &str,
    mode: &str,
    rights: &str,
    id_map: &str,
) -> Result<String, JsValue> {
    let parse = |s| {
        serde_json::from_str::<serde_json::Value>(s).map_err(|e| JsValue::from_str(&e.to_string()))
    };
    let before =
        serde_json::from_value(parse(before)?).map_err(|e| JsValue::from_str(&format!("{e}")))?;
    let after =
        serde_json::from_value(parse(after)?).map_err(|e| JsValue::from_str(&format!("{e}")))?;
    let rights =
        serde_json::from_value(parse(rights)?).map_err(|e| JsValue::from_str(&format!("{e}")))?;
    let mapping =
        serde_json::from_value(parse(id_map)?).map_err(|e| JsValue::from_str(&format!("{e}")))?;
    scribyra_core::history::restore_plan(&before, &after, mode, &rights, &mapping)
        .map(|value| value.to_string())
        .map_err(|e| JsValue::from_str(&serde_json::to_string(&e).unwrap()))
}

#[wasm_bindgen]
pub fn history_discussion_projection(
    root: &str,
    target: &str,
    record: &str,
    events: &str,
) -> Result<String, JsValue> {
    let parse = |s| serde_json::from_str(s).map_err(|e| JsValue::from_str(&format!("{e}")));
    let events = serde_json::from_str(events).map_err(|e| JsValue::from_str(&format!("{e}")))?;
    let result =
        scribyra_core::history::discussion_projection(root, target, parse(record)?, events)
            .map_err(|e| JsValue::from_str(&e))?;
    serde_json::to_string(&result).map_err(|e| JsValue::from_str(&format!("{e}")))
}

#[wasm_bindgen]
pub fn history_discussion_heads(target: &str, events: &str) -> Result<String, JsValue> {
    let events = serde_json::from_str(events).map_err(|e| JsValue::from_str(&format!("{e}")))?;
    let heads = scribyra_core::history::discussion_heads(target, events)
        .map_err(|e| JsValue::from_str(&e))?;
    serde_json::to_string(&heads).map_err(|e| JsValue::from_str(&format!("{e}")))
}
