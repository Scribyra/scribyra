//! Keep OS DNS work bounded even if a timed-out system lookup never returns.
//! ureq's default timed resolver can otherwise spawn another lookup per retry.
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::Duration;
use ureq::{
    config::Config,
    http::Uri,
    unversioned::{
        resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver},
        transport::NextTimeout,
    },
};

#[derive(Debug)]
pub(super) struct BoundedResolver {
    busy: Arc<AtomicBool>,
    inner: Arc<dyn Resolver>,
}
impl Default for BoundedResolver {
    fn default() -> Self {
        Self {
            busy: Arc::new(AtomicBool::new(false)),
            inner: Arc::new(DefaultResolver::default()),
        }
    }
}
struct Release(Arc<AtomicBool>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl Resolver for BoundedResolver {
    fn resolve(
        &self,
        uri: &Uri,
        config: &Config,
        timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        if self
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(ureq::Error::Timeout(timeout.reason));
        }
        let (tx, rx) = mpsc::sync_channel(1);
        let uri = uri.clone();
        let config = config.clone();
        let inner = self.inner.clone();
        let busy = self.busy.clone();
        if std::thread::Builder::new()
            .name("scribyra-telemetry-dns".into())
            .spawn(move || {
                let _release = Release(busy);
                // With no inner timeout, DefaultResolver uses the system resolver
                // synchronously instead of creating another detached timeout thread.
                let result = inner.resolve(&uri, &config, NextTimeout::default());
                let _ = tx.send(result);
            })
            .is_err()
        {
            self.busy.store(false, Ordering::Release);
            return Err(ureq::Error::HostNotFound);
        }
        let limit = if timeout.after.is_not_happening() {
            Duration::from_secs(2)
        } else {
            (*timeout.after).min(Duration::from_secs(2))
        };
        rx.recv_timeout(limit)
            .map_err(|_| ureq::Error::Timeout(timeout.reason))?
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, atomic::AtomicUsize};
    #[derive(Debug)]
    struct Stalled {
        calls: AtomicUsize,
        gate: Mutex<mpsc::Receiver<()>>,
    }
    impl Resolver for Stalled {
        fn resolve(
            &self,
            _: &Uri,
            _: &Config,
            _: NextTimeout,
        ) -> Result<ResolvedSocketAddrs, ureq::Error> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            let _ = self.gate.lock().unwrap().recv();
            Err(ureq::Error::HostNotFound)
        }
    }
    #[test]
    fn a_stalled_system_lookup_cannot_accumulate_threads_across_retries() {
        let (tx, rx) = mpsc::channel();
        let inner = Arc::new(Stalled {
            calls: AtomicUsize::new(0),
            gate: Mutex::new(rx),
        });
        let resolver = BoundedResolver {
            busy: Arc::new(AtomicBool::new(false)),
            inner: inner.clone(),
        };
        let config = ureq::Agent::config_builder().build();
        let uri = "https://example.invalid/v1/events".parse().unwrap();
        let timeout = NextTimeout {
            after: Duration::from_millis(10).into(),
            ..NextTimeout::default()
        };
        assert!(resolver.resolve(&uri, &config, timeout).is_err());
        for _ in 0..100 {
            assert!(resolver.resolve(&uri, &config, timeout).is_err());
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while inner.calls.load(Ordering::Relaxed) == 0 && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(inner.calls.load(Ordering::Relaxed), 1);
        tx.send(()).unwrap();
        while resolver.busy.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert!(!resolver.busy.load(Ordering::Acquire));
    }
}
