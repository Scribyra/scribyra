//! envtest-style control plane: etcd, kube-apiserver and kube-controller-manager as plain
//! processes (binaries from nixpkgs `kubernetes` and `etcd`; no containers, no kubelet, no
//! scheduler). Pods are created but never run. The controller manager runs only the
//! garbage collector and the Deployment, ReplicaSet, StatefulSet, namespace and service-account
//! controllers, so owner references, rollouts to (pending) pods and scaling to zero are real;
//! the Job controller is off so tests decide when a migration Job completes.

#![allow(dead_code)]

use kube::config::{KubeConfigOptions, Kubeconfig};
use rcgen::{BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub struct ControlPlane {
    pub dir: tempfile::TempDir,
    children: Vec<Child>,
    pub url: String,
    kubeconfig: PathBuf,
}
impl Drop for ControlPlane {
    fn drop(&mut self) {
        for child in self.children.iter_mut().rev() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// `name` from `$KUBEBUILDER_ASSETS`, `$ENVTEST_BIN_DIR` or `PATH`.
pub fn binary(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = ["KUBEBUILDER_ASSETS", "ENVTEST_BIN_DIR"].iter().filter_map(std::env::var_os).map(PathBuf::from).collect();
    dirs.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn write(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
}

impl ControlPlane {
    /// Start the control plane, or `None` when the binaries are missing and
    /// `SCRIBYRA_ENVTEST_REQUIRED` is not set (then the caller skips).
    pub async fn start() -> Option<Self> {
        let names = ["etcd", "kube-apiserver", "kube-controller-manager"];
        let found: Vec<Option<PathBuf>> = names.iter().map(|n| binary(n)).collect();
        if found.iter().any(Option::is_none) {
            assert!(std::env::var_os("SCRIBYRA_ENVTEST_REQUIRED").is_none(), "envtest binaries missing: {names:?}; run in `nix develop .#operator`");
            eprintln!("skipping: etcd, kube-apiserver and kube-controller-manager are not on PATH (use `nix develop .#operator`)");
            return None;
        }
        let [etcd, apiserver, manager] = [found[0].clone().unwrap(), found[1].clone().unwrap(), found[2].clone().unwrap()];
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().to_path_buf();
        let d = d.as_path();

        // Certificates: one CA for serving and clients; an admin client in system:masters.
        let mut ca = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca.distinguished_name.push(DnType::CommonName, "envtest-ca");
        ca.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::DigitalSignature, KeyUsagePurpose::CrlSign];
        let ca_key = KeyPair::generate().unwrap();
        let ca_cert = ca.self_signed(&ca_key).unwrap();
        let issuer = Issuer::new(ca, ca_key);
        let leaf = |names: Vec<String>, cn: &str, org: Option<&str>, eku: ExtendedKeyUsagePurpose| {
            let mut p = CertificateParams::new(names).unwrap();
            p.distinguished_name.push(DnType::CommonName, cn);
            if let Some(o) = org {
                p.distinguished_name.push(DnType::OrganizationName, o);
            }
            p.extended_key_usages = vec![eku];
            p.key_usages = vec![KeyUsagePurpose::DigitalSignature, KeyUsagePurpose::KeyEncipherment];
            let key = KeyPair::generate().unwrap();
            let cert = p.signed_by(&key, &issuer).unwrap();
            (cert.pem(), key.serialize_pem())
        };
        let (serving, serving_key) = leaf(vec!["127.0.0.1".into(), "localhost".into()], "kube-apiserver", None, ExtendedKeyUsagePurpose::ServerAuth);
        let (admin, admin_key) = leaf(vec![], "envtest-admin", Some("system:masters"), ExtendedKeyUsagePurpose::ClientAuth);
        let sa = KeyPair::generate().unwrap();
        let (sa_key, sa_pub) = (sa.serialize_pem(), sa.public_key_pem());
        for (name, text) in [("ca.crt", ca_cert.pem()), ("serving.crt", serving), ("serving.key", serving_key), ("admin.crt", admin), ("admin.key", admin_key), ("sa.key", sa_key), ("sa.pub", sa_pub)] {
            write(&d.join(name), &text);
        }

        let log = |name: &str| std::fs::File::create(d.join(format!("{name}.log"))).unwrap();
        let (etcd_port, peer_port, api_port) = (free_port(), free_port(), free_port());
        let mut children = vec![];
        children.push(
            Command::new(etcd)
                .args(["--data-dir", d.join("etcd").to_str().unwrap()])
                .args(["--listen-client-urls", &format!("http://127.0.0.1:{etcd_port}"), "--advertise-client-urls", &format!("http://127.0.0.1:{etcd_port}")])
                .args(["--listen-peer-urls", &format!("http://127.0.0.1:{peer_port}"), "--initial-advertise-peer-urls", &format!("http://127.0.0.1:{peer_port}")])
                .args(["--initial-cluster", &format!("default=http://127.0.0.1:{peer_port}"), "--unsafe-no-fsync", "--log-level", "warn"])
                .stdout(Stdio::null())
                .stderr(log("etcd"))
                .spawn()
                .unwrap(),
        );
        let p = |n: &str| d.join(n).to_str().unwrap().to_string();
        children.push(
            Command::new(apiserver)
                .args(["--etcd-servers", &format!("http://127.0.0.1:{etcd_port}")])
                .args(["--bind-address", "127.0.0.1", "--secure-port", &api_port.to_string()])
                .args(["--tls-cert-file", &p("serving.crt"), "--tls-private-key-file", &p("serving.key"), "--client-ca-file", &p("ca.crt")])
                .args(["--advertise-address", "127.0.0.1", "--endpoint-reconciler-type", "none", "--service-account-key-file", &p("sa.pub"), "--service-account-signing-key-file", &p("sa.key"), "--service-account-issuer", "https://kubernetes.default.svc"])
                .args(["--authorization-mode", "RBAC", "--service-cluster-ip-range", "10.96.0.0/16", "--allow-privileged=false"])
                .args(["--disable-admission-plugins", "ServiceAccount", "--cert-dir", &p("apiserver-certs"), "--v", "1"])
                .stdout(Stdio::null())
                .stderr(log("kube-apiserver"))
                .spawn()
                .unwrap(),
        );
        let url = format!("https://127.0.0.1:{api_port}");
        let kubeconfig = d.join("kubeconfig");
        write(
            &kubeconfig,
            &format!(
                "apiVersion: v1\nkind: Config\nclusters:\n- name: envtest\n  cluster:\n    server: {url}\n    certificate-authority: {ca}\nusers:\n- name: admin\n  user:\n    client-certificate: {crt}\n    client-key: {key}\ncontexts:\n- name: envtest\n  context: {{cluster: envtest, user: admin}}\ncurrent-context: envtest\n",
                ca = p("ca.crt"),
                crt = p("admin.crt"),
                key = p("admin.key")
            ),
        );
        let mut plane = ControlPlane { dir, children, url, kubeconfig };
        plane.wait_ready().await;
        let manager_port = free_port();
        plane.children.push(
            Command::new(manager)
                .args(["--kubeconfig", &plane.kubeconfig.to_string_lossy(), "--leader-elect=false", "--secure-port", &manager_port.to_string()])
                .args(["--authentication-skip-lookup", "--authorization-always-allow-paths", "/healthz"])
                .args(["--service-account-private-key-file", &p("sa.key"), "--root-ca-file", &p("ca.crt"), "--use-service-account-credentials=false"])
                .args(["--controllers", "garbage-collector-controller,deployment-controller,replicaset-controller,statefulset-controller,namespace-controller,serviceaccount-controller,serviceaccount-token-controller"])
                .args(["--concurrent-gc-syncs", "5", "--v", "1"])
                .stdout(Stdio::null())
                .stderr(log("kube-controller-manager"))
                .spawn()
                .unwrap(),
        );
        Some(plane)
    }

    async fn wait_ready(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            if let Ok(client) = tokio::time::timeout(Duration::from_secs(5), self.client(None)).await {
                let request = http::Request::get("/readyz").body(vec![]).unwrap();
                if let Ok(Ok(text)) = tokio::time::timeout(Duration::from_secs(5), client.request_text(request)).await
                    && text == "ok"
                {
                    return;
                }
            }
            for child in &mut self.children {
                if let Ok(Some(status)) = child.try_wait() {
                    panic!("control plane process exited ({status})\n{}", self.logs());
                }
            }
            assert!(Instant::now() < deadline, "kube-apiserver not ready\n{}", self.logs());
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    pub async fn client(&self, impersonate: Option<&str>) -> kube::Client {
        let mut kc = Kubeconfig::read_from(&self.kubeconfig).unwrap();
        if let Some(user) = impersonate {
            kc.auth_infos[0].auth_info.as_mut().unwrap().impersonate = Some(user.into());
        }
        let config = kube::Config::from_custom_kubeconfig(kc, &KubeConfigOptions::default()).await.unwrap();
        kube::Client::try_from(config).unwrap()
    }

    /// The last lines of each process's log.
    pub fn logs(&self) -> String {
        let mut out = String::new();
        for name in ["etcd", "kube-apiserver", "kube-controller-manager"] {
            let text = std::fs::read_to_string(self.dir.path().join(format!("{name}.log"))).unwrap_or_default();
            let lines: Vec<&str> = text.lines().collect();
            out.push_str(&format!("--- {name}.log (last 15 lines)\n{}\n", lines[lines.len().saturating_sub(15)..].join("\n")));
        }
        out
    }
}

/// Poll `check` until it returns `Some`, or panic with `what` after `secs`.
pub async fn eventually<T, F, Fut>(secs: u64, what: &str, mut check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(v) = check().await {
            return v;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
