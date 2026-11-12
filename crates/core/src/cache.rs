//! Device cache preferences and deterministic eviction, shared with a companion.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
pub const MIB: u64 = 1024 * 1024;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub version: u8,
    pub archive_bytes: u64,
    pub metadata_bytes: u64,
    pub runtime_bytes: u64,
    pub partial_bytes: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            version: 1,
            archive_bytes: 128 * MIB,
            metadata_bytes: 32 * MIB,
            runtime_bytes: 256 * MIB,
            partial_bytes: 128 * MIB,
        }
    }
}
impl Limits {
    pub fn maximum() -> Self {
        Self {
            version: 1,
            archive_bytes: 2048 * MIB,
            metadata_bytes: 256 * MIB,
            runtime_bytes: 2048 * MIB,
            partial_bytes: 512 * MIB,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        let max = Self::maximum();
        if self.version != 1
            || [
                (self.archive_bytes, max.archive_bytes),
                (self.metadata_bytes, max.metadata_bytes),
                (self.runtime_bytes, max.runtime_bytes),
                (self.partial_bytes, max.partial_bytes),
            ]
            .iter()
            .any(|(value, max)| value > max || value % MIB != 0)
        {
            return Err("Cache limits must be whole MiB within the supported range (zero disables a cache).".into());
        }
        Ok(())
    }
    fn limit(&self, kind: Kind) -> u64 {
        match kind {
            Kind::Archive => self.archive_bytes,
            Kind::Metadata => self.metadata_bytes,
            Kind::Runtime => self.runtime_bytes,
            Kind::Partial => self.partial_bytes,
        }
    }
}
pub fn policy() -> serde_json::Value {
    serde_json::json!({"defaults":Limits::default(),"maximum":Limits::maximum(),"mib":MIB})
}
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Archive,
    Metadata,
    Runtime,
    Partial,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub kind: Kind,
    pub size: u64,
    pub used: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub settings: Limits,
    pub existing: Vec<Entry>,
    pub incoming: Vec<Entry>,
}
pub fn eviction(request: Request) -> Result<Vec<String>, String> {
    request.settings.validate()?;
    if request.existing.len() > 65536 || request.incoming.len() > 1024 {
        return Err("Cache inventory exceeds its limit".into());
    }
    let mut old = BTreeMap::new();
    let mut incoming = BTreeSet::new();
    let mut totals = BTreeMap::<Kind, u64>::new();
    for entry in request.existing {
        if entry.id.is_empty()
            || entry.id.len() > 256
            || entry.id.chars().any(char::is_control)
            || old.insert(entry.id.clone(), entry).is_some()
        {
            return Err("Invalid cache inventory".into());
        }
    }
    for entry in request.incoming {
        if entry.id.is_empty()
            || entry.id.len() > 256
            || entry.id.chars().any(char::is_control)
            || !incoming.insert(entry.id.clone())
        {
            return Err("Invalid incoming cache entries".into());
        }
        old.remove(&entry.id);
        let total = totals.entry(entry.kind).or_default();
        *total = total.checked_add(entry.size).ok_or("Cache size overflow")?;
        if *total > request.settings.limit(entry.kind) {
            return Err("Incoming entries exceed the configured cache limit".into());
        }
    }
    for entry in old.values() {
        let total = totals.entry(entry.kind).or_default();
        *total = total.checked_add(entry.size).ok_or("Cache size overflow")?;
    }
    let mut entries: Vec<_> = old.into_values().collect();
    entries.sort_by(|a, b| (a.used, &a.id).cmp(&(b.used, &b.id)));
    let mut remove = Vec::new();
    for entry in entries {
        let total = totals.entry(entry.kind).or_default();
        if *total > request.settings.limit(entry.kind) {
            *total -= entry.size;
            remove.push(entry.id);
        }
    }
    Ok(remove)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checked_in_policy_matches_rust() {
        assert_eq!(
            policy(),
            serde_json::from_str::<serde_json::Value>(include_str!(
                "../../../web/cache-policy.json"
            ))
            .unwrap()
        );
    }
    #[test]
    fn limits_and_eviction_preserve_incoming_entries_and_isolate_cache_kinds() {
        let mut settings = Limits::default();
        settings.archive_bytes = MIB;
        let plan = eviction(Request {
            settings: settings.clone(),
            existing: vec![
                Entry {
                    id: "old".into(),
                    kind: Kind::Archive,
                    size: MIB,
                    used: 1,
                },
                Entry {
                    id: "metadata".into(),
                    kind: Kind::Metadata,
                    size: 32 * MIB,
                    used: 0,
                },
            ],
            incoming: vec![Entry {
                id: "new".into(),
                kind: Kind::Archive,
                size: MIB / 2,
                used: 2,
            }],
        })
        .unwrap();
        assert_eq!(plan, vec!["old"]);
        settings.archive_bytes = 0;
        assert!(
            eviction(Request {
                settings,
                existing: vec![],
                incoming: vec![Entry {
                    id: "new".into(),
                    kind: Kind::Archive,
                    size: 1,
                    used: 0
                }]
            })
            .is_err()
        );
        let mut bad = Limits::default();
        bad.metadata_bytes = 1;
        assert!(bad.validate().is_err());
        bad.metadata_bytes = 257 * MIB;
        assert!(bad.validate().is_err());
    }
}
