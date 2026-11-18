//! Releases this operator knows and the upgrade paths between them.
//!
//! Migrations are append-only and never rolled back automatically, so the operator refuses a
//! downgrade, a release it does not know, and an upgrade that skips a release whose migrations
//! a later one assumes (`upgrades_from`). New releases are added here with the operator.

use semver::{Version, VersionReq};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    /// The running releases this one may be upgraded from (a semver requirement); `None` for a
    /// release that only installs fresh.
    pub upgrades_from: Option<String>,
    /// The API still holds a single-writer advisory lock on the database (design section 10,
    /// until slice 19): one replica, `Recreate` rollouts, and the old pods stop before the
    /// migration Job takes the lock.
    pub single_writer: bool,
}

/// The releases compiled into this operator.
pub fn known() -> Vec<Release> {
    vec![Release { version: "0.2.0".into(), upgrades_from: None, single_writer: true }]
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Nothing to upgrade: `version` runs (or will run on a fresh install).
    Run(Release),
    /// Upgrade from the running release to this one.
    Upgrade(Release),
    /// Refused; the running release stays.
    Blocked { reason: &'static str, message: String },
}

/// Annotation that lets a resource run a release this operator does not know (development
/// builds). It is treated as single-writer and skips the path check; never use it in production.
pub const ALLOW_UNKNOWN: &str = "scribyra.com/allow-unknown-version";

pub fn decide(releases: &[Release], running: Option<&str>, wanted: &str, allow_unknown: bool) -> Decision {
    let find = |v: &str| releases.iter().find(|r| r.version == v).cloned();
    let target = match find(wanted) {
        Some(r) => r,
        None if allow_unknown => Release { version: wanted.into(), upgrades_from: None, single_writer: true },
        None => {
            return Decision::Blocked {
                reason: "UnknownVersion",
                message: format!("this operator does not know release {wanted}; upgrade the operator first (known: {})", releases.iter().map(|r| r.version.as_str()).collect::<Vec<_>>().join(", ")),
            };
        }
    };
    let Some(running) = running else { return Decision::Run(target) };
    if running == wanted {
        return Decision::Run(target);
    }
    let (Ok(from), Ok(to)) = (Version::parse(running), Version::parse(wanted)) else {
        return Decision::Blocked { reason: "InvalidVersion", message: format!("cannot compare {running} and {wanted}") };
    };
    if to < from {
        return Decision::Blocked {
            reason: "Downgrade",
            message: format!("{wanted} is older than the running {running}; the database schema is never rolled back automatically (restore a backup taken before the upgrade instead)"),
        };
    }
    if allow_unknown {
        return Decision::Upgrade(target);
    }
    let allowed = target.upgrades_from.as_deref().and_then(|req| VersionReq::parse(req).ok()).is_some_and(|req| req.matches(&from));
    if !allowed {
        let via = releases
            .iter()
            .filter_map(|r| Some((Version::parse(&r.version).ok()?, r)))
            .filter(|(v, r)| *v > from && *v < to && r.upgrades_from.as_deref().and_then(|q| VersionReq::parse(q).ok()).is_some_and(|q| q.matches(&from)))
            .map(|(_, r)| r.version.clone())
            .next_back();
        return Decision::Blocked {
            reason: "UnsupportedUpgradePath",
            message: match via {
                Some(v) => format!("{wanted} cannot be upgraded to from {running}; upgrade to {v} first"),
                None => format!("{wanted} cannot be upgraded to from {running} (it accepts {})", target.upgrades_from.as_deref().unwrap_or("fresh installs only")),
            },
        };
    }
    Decision::Upgrade(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn table() -> Vec<Release> {
        vec![
            Release { version: "1.0.0".into(), upgrades_from: None, single_writer: true },
            Release { version: "1.1.0".into(), upgrades_from: Some(">=1.0.0, <1.1.0".into()), single_writer: false },
            Release { version: "1.2.0".into(), upgrades_from: Some(">=1.1.0, <1.2.0".into()), single_writer: false },
        ]
    }
    #[test]
    fn fresh_install_and_steady_state() {
        assert!(matches!(decide(&table(), None, "1.2.0", false), Decision::Run(r) if r.version == "1.2.0"));
        assert!(matches!(decide(&table(), Some("1.1.0"), "1.1.0", false), Decision::Run(_)));
    }
    #[test]
    fn upgrade_one_step() {
        assert!(matches!(decide(&table(), Some("1.0.0"), "1.1.0", false), Decision::Upgrade(r) if !r.single_writer));
    }
    #[test]
    fn skipping_a_release_is_blocked_and_names_the_step() {
        let Decision::Blocked { reason, message } = decide(&table(), Some("1.0.0"), "1.2.0", false) else { panic!() };
        assert_eq!(reason, "UnsupportedUpgradePath");
        assert!(message.contains("upgrade to 1.1.0 first"), "{message}");
    }
    #[test]
    fn downgrade_and_unknown_are_blocked() {
        assert!(matches!(decide(&table(), Some("1.1.0"), "1.0.0", false), Decision::Blocked { reason: "Downgrade", .. }));
        assert!(matches!(decide(&table(), Some("1.1.0"), "9.0.0", false), Decision::Blocked { reason: "UnknownVersion", .. }));
        assert!(matches!(decide(&table(), Some("1.1.0"), "9.0.0", true), Decision::Upgrade(r) if r.single_writer));
        assert!(matches!(decide(&table(), Some("1.1.0"), "1.0.5", true), Decision::Blocked { reason: "Downgrade", .. }));
    }
}
