//! Port forwarding runtime — start / stop local TCP forwarding through SSH.
//!
//! Each active set of port forwards for a session is tracked by `runtime_id` in
//! a global map. When the PTY session opens, enabled forwards are started; when
//! the PTY session closes they are aborted.

use std::collections::HashMap;
use std::sync::Arc;

use once_cell::sync::Lazy;
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

use crate::sessions::{PortForward, PortForwardType};
use crate::ssh::pty::SshSession;

/// Active forward tasks keyed by `runtime_id`.
static FORWARD_TASKS: Lazy<RwLock<HashMap<String, Vec<JoinHandle<()>>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Start all enabled forwards for a session and track them by `runtime_id`.
pub async fn start_forwards(
    runtime_id: &str,
    session: Arc<SshSession>,
    forwards: &[PortForward],
) {
    let mut tasks = Vec::new();
    for fw in forwards.iter().filter(|f| f.enabled) {
        match fw.forward_type {
            PortForwardType::Local => {
                tasks.push(start_local_forward(session.clone(), fw));
            }
            PortForwardType::Remote => {
                // TODO: remote forwarding (requires server-side tcpip-forward)
                tracing::warn!(
                    id = %fw.id,
                    label = ?fw.label,
                    "remote port forwarding not yet implemented, skipping"
                );
            }
        }
    }
    if !tasks.is_empty() {
        tracing::info!(
            runtime_id = %runtime_id,
            count = tasks.len(),
            "started port forwards"
        );
        FORWARD_TASKS
            .write()
            .await
            .insert(runtime_id.to_string(), tasks);
    }
}

/// Abort all running forwards for a session.
pub async fn stop_forwards(runtime_id: &str) {
    if let Some(tasks) = FORWARD_TASKS.write().await.remove(runtime_id) {
        for task in &tasks {
            task.abort();
        }
        tracing::info!(
            runtime_id = %runtime_id,
            count = tasks.len(),
            "stopped port forwards"
        );
    }
}

/// Start local port forwarding: bind a local TCP listener and relay each
/// accepted connection through an SSH `direct-tcpip` channel to the remote
/// target.
///
/// Returns a `JoinHandle` that can be aborted to stop the forwarding.
fn start_local_forward(
    session: Arc<SshSession>,
    fw: &PortForward,
) -> JoinHandle<()> {
    let bind_addr = format!("{}:{}", fw.bind_host, fw.bind_port);
    let target_host = fw.target_host.clone();
    let target_port = fw.target_port;
    let label = fw.label.clone().unwrap_or_default();

    tokio::spawn(async move {
        let listener = match TcpListener::bind(&bind_addr).await {
            Ok(l) => l,
            Err(e) => {
                tracing::error!(
                    forward = %label, bind = %bind_addr, error = %e,
                    "failed to bind local forward"
                );
                return;
            }
        };
        tracing::info!(
            forward = %label,
            bind = %bind_addr,
            target = %format!("{}:{}", target_host, target_port),
            "local port forward started"
        );

        loop {
            let (mut tcp_stream, peer) = match listener.accept().await {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "accept failed on local forward");
                    continue;
                }
            };
            tracing::debug!(peer = %peer, "local forward: incoming connection");

            let session = session.clone();
            let host = target_host.clone();
            let port = target_port;

            tokio::spawn(async move {
                let channel = match session
                    .channel_open_direct_tcpip(&host, port as u32, "127.0.0.1", 0)
                    .await
                {
                    Ok(ch) => ch,
                    Err(e) => {
                        tracing::error!(error = %e, "failed to open direct-tcpip channel");
                        return;
                    }
                };

                let mut channel_stream = channel.into_stream();

                match tokio::io::copy_bidirectional(&mut tcp_stream, &mut channel_stream)
                    .await
                {
                    Ok((up, down)) => {
                        tracing::debug!(
                            up_bytes = up, down_bytes = down,
                            "local forward connection closed"
                        );
                    }
                    Err(e) => {
                        // Broken pipe / connection reset are normal when either
                        // side closes — only log unexpected errors.
                        let kind = e.kind();
                        if kind != std::io::ErrorKind::BrokenPipe
                            && kind != std::io::ErrorKind::ConnectionReset
                        {
                            tracing::warn!(error = %e, "local forward relay error");
                        }
                    }
                }
            });
        }
    })
}
