//! Ad-hoc sanity probe for `prossh_lib::ssh::test_connect`.
//!
//! Runs against an external SSH server (e.g. the mock paramiko server at
//! `127.0.0.1:2222`) using credentials passed via environment variables so the
//! example can be committed without leaking secrets.
//!
//! Usage:
//!
//! ```powershell
//! $env:PROSSH_TEST_HOST="127.0.0.1"
//! $env:PROSSH_TEST_PORT="2222"
//! $env:PROSSH_TEST_USER="testuser"
//! $env:PROSSH_TEST_PASS="testpass123"
//! cargo run --example ssh_probe --no-default-features
//! ```
//!
//! The example writes a fresh, empty known_hosts.json into a tmp dir so the
//! TOFU path is always exercised.

use std::path::PathBuf;
use std::sync::Arc;

use prossh_lib::known_hosts::KnownHostsStore;
use prossh_lib::ssh;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let host = std::env::var("PROSSH_TEST_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("PROSSH_TEST_PORT")
        .unwrap_or_else(|_| "2222".into())
        .parse()?;
    let username = std::env::var("PROSSH_TEST_USER").unwrap_or_else(|_| "testuser".into());
    let password = std::env::var("PROSSH_TEST_PASS").unwrap_or_else(|_| "testpass123".into());
    let command = std::env::var("PROSSH_TEST_CMD").unwrap_or_else(|_| "whoami".into());

    // Fresh, throwaway known_hosts file so we always exercise the TOFU branch.
    let mut tmp = std::env::temp_dir();
    tmp.push(format!("prossh-probe-known_hosts-{}.json", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let store = Arc::new(KnownHostsStore::load(&tmp)?);

    println!("probing {host}:{port} as {username}, running {command:?}");
    println!("tmp known_hosts: {}", tmp.display());

    let res = ssh::test_connect(store.clone(), host, port, username, password, command).await?;
    println!("--- result ---");
    println!("elapsed_ms      = {}", res.elapsed_ms);
    println!("exit_code       = {:?}", res.exit_code);
    println!("stdout          = {:?}", res.stdout);
    println!("stderr          = {:?}", res.stderr);
    println!("host_key_algo   = {}", res.host_key.algorithm);
    println!("host_key_fp     = {}", res.host_key.fingerprint);
    println!("host_key_status = {:?}", res.host_key.status);

    // Dump the resulting known_hosts file to prove TOFU actually wrote it.
    println!("--- persisted known_hosts.json ---");
    println!("{}", std::fs::read_to_string(&tmp)?);

    // Second run should now report Trusted instead of NewlyAdded.
    let store2 = Arc::new(KnownHostsStore::load(&tmp)?);
    let res2 = ssh::test_connect(
        store2,
        std::env::var("PROSSH_TEST_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
        port,
        std::env::var("PROSSH_TEST_USER").unwrap_or_else(|_| "testuser".into()),
        std::env::var("PROSSH_TEST_PASS").unwrap_or_else(|_| "testpass123".into()),
        "hostname".into(),
    )
    .await?;
    println!("--- second run (should be Trusted) ---");
    println!("host_key_status = {:?}", res2.host_key.status);
    println!("stdout          = {:?}", res2.stdout);

    let _: PathBuf = tmp; // silence unused import warning if any
    Ok(())
}
