//! Leader election on a `coordination.k8s.io/v1` Lease: only the holder reconciles. A replica
//! that loses the lease exits, so a restarted pod starts again as a candidate and two replicas
//! never reconcile at once.

use k8s_openapi::api::coordination::v1::Lease;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::MicroTime;
use kube::api::{Api, Patch, PatchParams, PostParams};
use serde_json::json;
use std::time::Duration;

pub const LEASE_SECONDS: i32 = 15;
const RENEW: Duration = Duration::from_secs(5);

pub struct Elector {
    api: Api<Lease>,
    name: String,
    identity: String,
}
impl Elector {
    pub fn new(client: kube::Client, namespace: &str, name: &str, identity: &str) -> Self {
        Self { api: Api::namespaced(client, namespace), name: name.into(), identity: identity.into() }
    }
    /// One attempt to take or renew the lease. Uses the resourceVersion for an optimistic
    /// update, so two candidates cannot both win.
    pub async fn try_acquire(&self) -> Result<bool, kube::Error> {
        let now = k8s_openapi::jiff::Timestamp::now();
        let Some(lease) = self.api.get_opt(&self.name).await? else {
            let lease: Lease = serde_json::from_value(json!({
                "metadata": {"name": self.name},
                "spec": {"holderIdentity": self.identity, "leaseDurationSeconds": LEASE_SECONDS, "acquireTime": MicroTime(now), "renewTime": MicroTime(now), "leaseTransitions": 0}
            }))
            .unwrap();
            return match self.api.create(&PostParams::default(), &lease).await {
                Ok(_) => Ok(true),
                Err(kube::Error::Api(e)) if e.code == 409 => Ok(false),
                Err(e) => Err(e),
            };
        };
        let spec = lease.spec.clone().unwrap_or_default();
        let holder = spec.holder_identity.clone().unwrap_or_default();
        let duration = spec.lease_duration_seconds.unwrap_or(LEASE_SECONDS) as i64;
        let expired = spec.renew_time.as_ref().is_none_or(|t| now.duration_since(t.0).as_secs() > duration);
        if holder != self.identity && !expired {
            return Ok(false);
        }
        let transitions = spec.lease_transitions.unwrap_or(0) + if holder == self.identity { 0 } else { 1 };
        let acquire = if holder == self.identity { spec.acquire_time.clone().unwrap_or(MicroTime(now)) } else { MicroTime(now) };
        let patch = json!({
            "metadata": {"resourceVersion": lease.metadata.resource_version},
            "spec": {"holderIdentity": self.identity, "leaseDurationSeconds": LEASE_SECONDS, "acquireTime": acquire, "renewTime": MicroTime(now), "leaseTransitions": transitions}
        });
        match self.api.patch(&self.name, &PatchParams::default(), &Patch::Merge(&patch)).await {
            Ok(_) => Ok(true),
            Err(kube::Error::Api(e)) if e.code == 409 => Ok(false),
            Err(e) => Err(e),
        }
    }
    /// Wait until this replica holds the lease.
    pub async fn acquire(&self) {
        loop {
            match self.try_acquire().await {
                Ok(true) => return,
                Ok(false) => {}
                Err(error) => tracing::warn!(%error, "lease"),
            }
            tokio::time::sleep(RENEW).await;
        }
    }
    /// Renew until a renewal fails for longer than the lease; then return (the caller exits).
    pub async fn hold(&self) {
        let mut last = tokio::time::Instant::now();
        loop {
            tokio::time::sleep(RENEW).await;
            match self.try_acquire().await {
                Ok(true) => last = tokio::time::Instant::now(),
                Ok(false) => return,
                Err(error) => {
                    tracing::warn!(%error, "lease renewal");
                    if last.elapsed() > Duration::from_secs(LEASE_SECONDS as u64 - 3) {
                        return;
                    }
                }
            }
        }
    }
}
