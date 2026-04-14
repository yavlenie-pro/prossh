//! Remote system monitoring — OS info, CPU, RAM, disk usage of the remote host.
//!
//! Split into two polling tiers:
//! - **fast** (`remote_stats_fast`): CPU, RAM, swap, load avg — polled every ~1s
//! - **slow** (`remote_stats_slow`): OS info, kernel, hostname, uptime, disks, GPUs — polled every ~5s
//!
//! CPU usage is computed as a delta between the current `/proc/stat` snapshot and
//! the one stored from the previous poll (kept in `CPU_PREV`). This removes the
//! need for a `sleep 0.3` inside the script, making each exec nearly instant.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Serialize;
use tauri::State;
use tokio::sync::RwLock;

use crate::error::AppError;
use crate::state::AppState;

// ── Types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub mount_point: String,
    pub filesystem: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub index: u32,
    pub name: String,
    /// GPU utilisation 0–100
    pub gpu_util: f32,
    /// Memory utilisation 0–100
    pub mem_util: f32,
    /// VRAM used in bytes
    pub mem_used: u64,
    /// VRAM total in bytes
    pub mem_total: u64,
    /// Temperature in °C
    pub temperature: u32,
    /// Power draw in watts (0 if unavailable)
    pub power_draw: f32,
    /// Fan speed 0–100 (0 if unavailable or N/A)
    pub fan_pct: u32,
}

/// Network interface throughput (bytes/sec, computed from delta).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetInterface {
    pub name: String,
    /// Receive bytes per second
    pub rx_bytes_sec: f64,
    /// Transmit bytes per second
    pub tx_bytes_sec: f64,
}

/// Fast-changing metrics polled every ~1s.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FastStats {
    /// Overall CPU usage 0–100
    pub cpu_usage: f32,
    pub cpu_cores: usize,
    pub load_avg: [f32; 3],
    pub ram_total: u64,
    pub ram_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    /// NVIDIA GPUs (empty if nvidia-smi not available)
    pub gpus: Vec<GpuInfo>,
    /// Network interface throughput
    pub net: Vec<NetInterface>,
    /// Name of the interface carrying the default route (if detected)
    pub default_iface: Option<String>,
}

/// Slow-changing metrics polled every ~5s.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlowStats {
    pub os_info: String,
    pub kernel: String,
    pub hostname: String,
    pub uptime_secs: u64,
    pub disks: Vec<DiskInfo>,
}

/// Legacy combined response — kept for backwards compatibility.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStats {
    pub os_info: String,
    pub kernel: String,
    pub hostname: String,
    pub cpu_usage: f32,
    pub cpu_cores: usize,
    pub load_avg: [f32; 3],
    pub ram_total: u64,
    pub ram_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub disks: Vec<DiskInfo>,
    pub uptime_secs: u64,
    pub gpus: Vec<GpuInfo>,
}

// ── Previous CPU snapshot cache ─────────────────────────────────────────

/// Stores the previous `/proc/stat` CPU-line per `runtime_id`.
static CPU_PREV: LazyLock<RwLock<HashMap<String, CpuTimes>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Previous network counters per runtime_id: (timestamp_ms, HashMap<iface, (rx_bytes, tx_bytes)>).
type NetSnapshot = (std::time::Instant, HashMap<String, (u64, u64)>);
static NET_PREV: LazyLock<RwLock<HashMap<String, NetSnapshot>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

// ── Scripts ─────────────────────────────────────────────────────────────

/// Fast script: /proc/stat, nproc, loadavg, meminfo, nvidia-smi, /proc/net/dev
const FAST_SCRIPT: &str = r#"
head -1 /proc/stat
echo "===SECTION==="
nproc
echo "===SECTION==="
cat /proc/loadavg
echo "===SECTION==="
cat /proc/meminfo | head -8
echo "===SECTION==="
nvidia-smi --query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,fan.speed --format=csv,noheader,nounits 2>/dev/null || true
echo "===SECTION==="
cat /proc/net/dev 2>/dev/null | tail -n +3
echo "===SECTION==="
ip route show default 2>/dev/null | head -1
"#;

/// Slow script: os-release, kernel, hostname, uptime, df
const SLOW_SCRIPT: &str = r#"
cat /etc/os-release 2>/dev/null | head -5
echo "===SECTION==="
uname -r
echo "===SECTION==="
hostname
echo "===SECTION==="
cat /proc/uptime
echo "===SECTION==="
df -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | tail -n +2
"#;

/// Legacy all-in-one script (kept for `remote_stats` compatibility).
const STATS_SCRIPT: &str = r#"
cat /etc/os-release 2>/dev/null | head -5
echo "===SECTION==="
uname -r
echo "===SECTION==="
hostname
echo "===SECTION==="
head -1 /proc/stat
echo "===SECTION==="
sleep 0.3
head -1 /proc/stat
echo "===SECTION==="
nproc
echo "===SECTION==="
cat /proc/loadavg
echo "===SECTION==="
cat /proc/meminfo | head -8
echo "===SECTION==="
df -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | tail -n +2
echo "===SECTION==="
cat /proc/uptime
echo "===SECTION==="
nvidia-smi --query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,fan.speed --format=csv,noheader,nounits 2>/dev/null || true
"#;

// ── Commands ────────────────────────────────────────────────────────────

/// Fast poll: CPU, RAM, load avg, swap.  Designed to be called every ~1s.
#[tauri::command]
pub async fn remote_stats_fast(
    state: State<'_, AppState>,
    runtime_id: String,
) -> Result<FastStats, AppError> {
    let session = {
        let map = state.ssh_sessions.read().await;
        map.get(&runtime_id).cloned()
    };
    let session =
        session.ok_or_else(|| AppError::NotFound(format!("pty session {runtime_id}")))?;

    let raw = session.exec(FAST_SCRIPT).await?;
    let sections: Vec<&str> = raw.split("===SECTION===").collect();
    if sections.len() < 4 {
        return Err(AppError::Internal(format!(
            "fast stats: expected ≥4 sections, got {}",
            sections.len()
        )));
    }

    // CPU: single snapshot, delta against previous
    let current_cpu = parse_cpu_stat(sections[0].trim());
    let cpu_usage = {
        let mut prev_map = CPU_PREV.write().await;
        let usage = if let Some(prev) = prev_map.get(&runtime_id) {
            calc_cpu_usage(prev, &current_cpu)
        } else {
            0.0 // first poll — no delta yet
        };
        prev_map.insert(runtime_id.clone(), current_cpu);
        usage
    };

    let cpu_cores = sections[1].trim().parse::<usize>().unwrap_or(1);
    let load_avg = parse_loadavg(sections[2].trim());
    let (ram_total, ram_used, swap_total, swap_used) = parse_meminfo(sections[3].trim());

    let gpus = if sections.len() > 4 {
        parse_nvidia_smi(sections[4].trim())
    } else {
        Vec::new()
    };

    // Network: parse current counters and compute delta
    let current_net = if sections.len() > 5 {
        parse_proc_net_dev(sections[5].trim())
    } else {
        HashMap::new()
    };

    let net = {
        let mut prev_map = NET_PREV.write().await;
        let now = std::time::Instant::now();
        let interfaces = if let Some((prev_time, prev_counters)) = prev_map.get(&runtime_id) {
            let dt = now.duration_since(*prev_time).as_secs_f64();
            if dt > 0.0 {
                current_net
                    .iter()
                    .filter_map(|(name, &(rx, tx))| {
                        let (prev_rx, prev_tx) = prev_counters.get(name)?;
                        let rx_sec = rx.saturating_sub(*prev_rx) as f64 / dt;
                        let tx_sec = tx.saturating_sub(*prev_tx) as f64 / dt;
                        Some(NetInterface {
                            name: name.clone(),
                            rx_bytes_sec: rx_sec,
                            tx_bytes_sec: tx_sec,
                        })
                    })
                    .collect()
            } else {
                Vec::new()
            }
        } else {
            Vec::new() // first poll — no delta
        };
        prev_map.insert(runtime_id.clone(), (now, current_net));
        interfaces
    };

    // Default gateway interface: "default via X.X.X.X dev ethN ..."
    let default_iface = if sections.len() > 6 {
        parse_default_route(sections[6].trim())
    } else {
        None
    };

    Ok(FastStats {
        cpu_usage,
        cpu_cores,
        load_avg,
        ram_total,
        ram_used,
        swap_total,
        swap_used,
        gpus,
        net,
        default_iface,
    })
}

/// Slow poll: OS info, kernel, hostname, uptime, disks, GPUs.
/// Designed to be called every ~5s.
#[tauri::command]
pub async fn remote_stats_slow(
    state: State<'_, AppState>,
    runtime_id: String,
) -> Result<SlowStats, AppError> {
    let session = {
        let map = state.ssh_sessions.read().await;
        map.get(&runtime_id).cloned()
    };
    let session =
        session.ok_or_else(|| AppError::NotFound(format!("pty session {runtime_id}")))?;

    let raw = session.exec(SLOW_SCRIPT).await?;
    let sections: Vec<&str> = raw.split("===SECTION===").collect();
    if sections.len() < 5 {
        return Err(AppError::Internal(format!(
            "slow stats: expected ≥5 sections, got {}",
            sections.len()
        )));
    }

    let os_info = parse_os_release(sections[0].trim());
    let kernel = sections[1].trim().to_string();
    let hostname = sections[2].trim().to_string();

    let uptime_secs = sections[3]
        .trim()
        .split_whitespace()
        .next()
        .and_then(|s| s.parse::<f64>().ok())
        .map(|f| f as u64)
        .unwrap_or(0);

    let disks = parse_df(sections[4].trim());

    Ok(SlowStats {
        os_info,
        kernel,
        hostname,
        uptime_secs,
        disks,
    })
}

/// Clean up stored CPU + network snapshots when a session is closed.
pub async fn clear_stats_cache(runtime_id: &str) {
    CPU_PREV.write().await.remove(runtime_id);
    NET_PREV.write().await.remove(runtime_id);
}

/// Legacy combined command — kept so nothing breaks.
#[tauri::command]
pub async fn remote_stats(
    state: State<'_, AppState>,
    runtime_id: String,
) -> Result<RemoteStats, AppError> {
    let session = {
        let map = state.ssh_sessions.read().await;
        map.get(&runtime_id).cloned()
    };
    let session =
        session.ok_or_else(|| AppError::NotFound(format!("pty session {runtime_id}")))?;

    let raw = session.exec(STATS_SCRIPT).await?;
    parse_stats(&raw)
}

// ── Parsers (shared) ────────────────────────────────────────────────────

fn parse_stats(raw: &str) -> Result<RemoteStats, AppError> {
    let sections: Vec<&str> = raw.split("===SECTION===").collect();
    if sections.len() < 10 {
        return Err(AppError::Internal(format!(
            "unexpected remote output: {} sections",
            sections.len()
        )));
    }

    let os_info = parse_os_release(sections[0].trim());
    let kernel = sections[1].trim().to_string();
    let hostname = sections[2].trim().to_string();
    let cpu1 = parse_cpu_stat(sections[3].trim());
    let cpu2 = parse_cpu_stat(sections[4].trim());
    let cpu_usage = calc_cpu_usage(&cpu1, &cpu2);
    let cpu_cores = sections[5].trim().parse::<usize>().unwrap_or(1);
    let load_avg = parse_loadavg(sections[6].trim());
    let (ram_total, ram_used, swap_total, swap_used) = parse_meminfo(sections[7].trim());
    let disks = parse_df(sections[8].trim());
    let uptime_secs = sections[9]
        .trim()
        .split_whitespace()
        .next()
        .and_then(|s| s.parse::<f64>().ok())
        .map(|f| f as u64)
        .unwrap_or(0);
    let gpus = if sections.len() > 10 {
        parse_nvidia_smi(sections[10].trim())
    } else {
        Vec::new()
    };

    Ok(RemoteStats {
        os_info,
        kernel,
        hostname,
        cpu_usage,
        cpu_cores,
        load_avg,
        ram_total,
        ram_used,
        swap_total,
        swap_used,
        disks,
        uptime_secs,
        gpus,
    })
}

fn parse_os_release(s: &str) -> String {
    for line in s.lines() {
        if let Some(rest) = line.strip_prefix("PRETTY_NAME=") {
            return rest.trim_matches('"').to_string();
        }
    }
    for line in s.lines() {
        if let Some(rest) = line.strip_prefix("NAME=") {
            return rest.trim_matches('"').to_string();
        }
    }
    "Linux".to_string()
}

#[derive(Clone)]
struct CpuTimes {
    total: u64,
    idle: u64,
}

fn parse_cpu_stat(line: &str) -> CpuTimes {
    let nums: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|s| s.parse().ok())
        .collect();
    let total: u64 = nums.iter().sum();
    let idle = nums.get(3).copied().unwrap_or(0) + nums.get(4).copied().unwrap_or(0);
    CpuTimes { total, idle }
}

fn calc_cpu_usage(a: &CpuTimes, b: &CpuTimes) -> f32 {
    let total_d = b.total.saturating_sub(a.total) as f64;
    let idle_d = b.idle.saturating_sub(a.idle) as f64;
    if total_d == 0.0 {
        return 0.0;
    }
    ((total_d - idle_d) / total_d * 100.0) as f32
}

fn parse_loadavg(s: &str) -> [f32; 3] {
    let mut parts = s.split_whitespace();
    let a = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let b = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let c = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    [a, b, c]
}

fn parse_meminfo(s: &str) -> (u64, u64, u64, u64) {
    let mut total = 0u64;
    let mut free = 0u64;
    let mut available = 0u64;
    let mut buffers = 0u64;
    let mut cached = 0u64;
    let mut swap_total = 0u64;
    let mut swap_free = 0u64;

    for line in s.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        let val_kb: u64 = parts[1].parse().unwrap_or(0);
        match parts[0] {
            "MemTotal:" => total = val_kb * 1024,
            "MemFree:" => free = val_kb * 1024,
            "MemAvailable:" => available = val_kb * 1024,
            "Buffers:" => buffers = val_kb * 1024,
            "Cached:" => cached = val_kb * 1024,
            "SwapTotal:" => swap_total = val_kb * 1024,
            "SwapFree:" => swap_free = val_kb * 1024,
            _ => {}
        }
    }

    let used = if available > 0 {
        total.saturating_sub(available)
    } else {
        total.saturating_sub(free + buffers + cached)
    };
    let swap_used = swap_total.saturating_sub(swap_free);

    (total, used, swap_total, swap_used)
}

fn parse_nvidia_smi(s: &str) -> Vec<GpuInfo> {
    s.lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let cols: Vec<&str> = line.split(',').map(|c| c.trim()).collect();
            if cols.len() < 7 {
                return None;
            }
            let parse_f = |i: usize| -> f32 {
                cols.get(i)
                    .and_then(|v| v.trim_end_matches(" %").trim_end_matches(" W").parse().ok())
                    .unwrap_or(0.0)
            };
            let parse_u64 = |i: usize| -> u64 {
                cols.get(i)
                    .and_then(|v| v.trim_end_matches(" MiB").trim().parse::<u64>().ok())
                    .unwrap_or(0)
            };
            let parse_u32 = |i: usize| -> u32 {
                cols.get(i)
                    .and_then(|v| v.trim_end_matches(" %").trim().parse::<u32>().ok())
                    .unwrap_or(0)
            };

            Some(GpuInfo {
                index: cols[0].parse().unwrap_or(0),
                name: cols[1].to_string(),
                gpu_util: parse_f(2),
                mem_util: parse_f(3),
                mem_used: parse_u64(4) * 1024 * 1024,
                mem_total: parse_u64(5) * 1024 * 1024,
                temperature: parse_u32(6),
                power_draw: if cols.len() > 7 { parse_f(7) } else { 0.0 },
                fan_pct: if cols.len() > 8 { parse_u32(8) } else { 0 },
            })
        })
        .collect()
}

/// Parse `/proc/net/dev` output (lines after the 2-line header).
/// Format: `iface: rx_bytes rx_packets ... tx_bytes tx_packets ...`
/// Returns HashMap<iface_name, (rx_bytes, tx_bytes)>.
fn parse_proc_net_dev(s: &str) -> HashMap<String, (u64, u64)> {
    let mut result = HashMap::new();
    for line in s.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Split on ':' to get iface name and counters
        let Some((iface, rest)) = line.split_once(':') else {
            continue;
        };
        let iface = iface.trim();
        // Skip loopback
        if iface == "lo" {
            continue;
        }
        let nums: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect();
        // /proc/net/dev columns: rx_bytes(0) rx_packets(1) ... (8 rx fields) tx_bytes(8) tx_packets(9) ...
        if nums.len() >= 10 {
            result.insert(iface.to_string(), (nums[0], nums[8]));
        }
    }
    result
}

/// Parse `ip route show default` output.
/// Example: `default via 10.0.0.1 dev eth0 proto static metric 100`
/// Returns the interface name after `dev`.
fn parse_default_route(s: &str) -> Option<String> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    for (i, &word) in parts.iter().enumerate() {
        if word == "dev" {
            return parts.get(i + 1).map(|s| s.to_string());
        }
    }
    None
}

fn parse_df(s: &str) -> Vec<DiskInfo> {
    s.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 6 {
                return None;
            }
            let total: u64 = parts[1].parse().ok()?;
            let used: u64 = parts[2].parse().ok()?;
            if total < 500_000_000 {
                return None;
            }
            Some(DiskInfo {
                filesystem: parts[0].to_string(),
                mount_point: parts[5].to_string(),
                total_bytes: total,
                used_bytes: used,
            })
        })
        .collect()
}
