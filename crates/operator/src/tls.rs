//! A private CA for the in-cluster Garage, and the TLS proxy (`scribyra-operator tls-proxy`)
//! that runs beside Garage so its S3 and admin APIs are reached only over verified TLS.
//!
//! Garage serves plain HTTP; the service refuses plain-HTTP S3 endpoints that are not loopback,
//! and trusts only this CA for the in-cluster store (`s3_ca_file`).

use rcgen::{BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};

pub struct Material {
    pub ca_pem: String,
    pub cert_pem: String,
    pub key_pem: String,
}

/// A fresh CA (its key is discarded: nothing else is ever signed) and a server certificate for
/// `names`.
pub fn generate(names: &[String]) -> Result<Material, rcgen::Error> {
    let mut ca = CertificateParams::new(Vec::<String>::new())?;
    ca.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    ca.distinguished_name.push(DnType::CommonName, "scribyra in-cluster storage CA");
    ca.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let ca_key = KeyPair::generate()?;
    let ca_cert = ca.self_signed(&ca_key)?;
    let issuer = Issuer::new(ca, ca_key);
    let mut leaf = CertificateParams::new(names.to_vec())?;
    leaf.distinguished_name.push(DnType::CommonName, names.first().cloned().unwrap_or_default());
    leaf.use_authority_key_identifier_extension = true;
    leaf.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    leaf.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let key = KeyPair::generate()?;
    let cert = leaf.signed_by(&key, &issuer)?;
    Ok(Material { ca_pem: ca_cert.pem(), cert_pem: cert.pem(), key_pem: key.serialize_pem() })
}

/// Names the Garage certificate covers.
pub fn garage_names(name: &str, namespace: &str) -> Vec<String> {
    let svc = format!("{name}-garage");
    vec![format!("{svc}.{namespace}.svc"), format!("{svc}.{namespace}.svc.cluster.local"), format!("{svc}.{namespace}"), svc, "localhost".into()]
}

/// Accept TLS on each `listen` address and forward the plaintext to its `upstream`.
pub async fn proxy(routes: Vec<(String, String)>, cert_pem: &[u8], key_pem: &[u8]) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use rustls_pki_types::pem::PemObject;
    let certs = rustls_pki_types::CertificateDer::pem_slice_iter(cert_pem).collect::<Result<Vec<_>, _>>()?;
    let key = rustls_pki_types::PrivateKeyDer::from_pem_slice(key_pem)?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider).with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])?.with_no_client_auth().with_single_cert(certs, key)?;
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let mut tasks = vec![];
    for (listen, upstream) in routes {
        let listener = TcpListener::bind(&listen).await?;
        tracing::info!(%listen, %upstream, "tls proxy listening");
        let acceptor = acceptor.clone();
        tasks.push(tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    // For example too many open files: back off instead of spinning.
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    continue;
                };
                let acceptor = acceptor.clone();
                let upstream = upstream.clone();
                tokio::spawn(async move {
                    let Ok(Ok(mut tls)) = tokio::time::timeout(std::time::Duration::from_secs(10), acceptor.accept(socket)).await else { return };
                    let Ok(mut plain) = TcpStream::connect(&upstream).await else { return };
                    let _ = tokio::io::copy_bidirectional(&mut tls, &mut plain).await;
                });
            }
        }));
    }
    // The listeners run until the process stops; one ending (a panic) ends the proxy.
    let (result, _, _) = futures::future::select_all(tasks).await;
    result?;
    Err("a proxy listener stopped".into())
}
