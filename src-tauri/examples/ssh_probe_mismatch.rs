//! Verifies the "host key mismatch" branch of `ssh::test_connect`.
//!
//! Pre-populates a known_hosts.json with a bogus fingerprint for the target,
//! then asks `test_connect` to connect — expects an `AppError::Ssh` whose
//! message contains "host key mismatch".
//!
//! Run after starting the mock sshd separately.

use std::sync::Arc;

use chrono::Utc;
use prossh_lib::known_hosts::{KnownHostEntry, KnownHostsStore};
use prossh_lib::ssh;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let host = std::env::var("PROSSH_TEST_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("PROSSH_TEST_PORT")
        .unwrap_or_else(|_| "2222".into())
        .parse()?;
    let username = std::env::var("PROSSH_TEST_USER").unwrap_or_else(|_| "testuser".into());
    let password = std::env::var("PROSSH_TEST_PASS").unwrap_or_else(|_| "testpass123".into());

    let mut tmp = std::env::temp_dir();
    tmp.push(format!(
        "prossh-mismatch-known_hosts-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&tmp);

    let store = Arc::new(KnownHostsStore::load(&tmp)?);

    // Seed with a bogus fingerprint for ssh-rsa so the handshake trips into
    // the Mismatch branch.
    store.add(KnownHostEntry {
        host: host.clone(),
        port,
        algorithm: "ssh-rsa".into(),
        fingerprint: "SHA256:THISwasDefinitelyNeverTheRealFingerprintXXXXXXXXXXXX".into(),
        comment: Some("bogus seed for mismatch test".into()),
        added_at: Utc::now(),
    })?;

    println!("seeded bogus ssh-rsa fingerprint, probing {host}:{port}");
    match ssh::test_connect(
        store.clone(),
        host,
        port,
        username,
        password,
        "whoami".into(),
    )
    .await
    {
        Ok(res) => {
            eprintln!("UNEXPECTED success: {:?}", res);
            std::process::exit(2);
        }
        Err(e) => {
            let msg = e.to_string();
            println!("caught expected error: {msg}");
            if !msg.contains("host key mismatch") {
                eprintln!("error did not mention 'host key mismatch' — FAIL");
                std::process::exit(3);
            }
            println!("OK: mismatch branch fired");
        }
    }
    Ok(())
}
