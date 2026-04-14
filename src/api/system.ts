/**
 * Typed wrapper for remote system monitoring commands.
 *
 * Split into two polling tiers:
 * - **fast** (CPU, RAM, load, swap, GPU) — default 1 s
 * - **slow** (OS info, kernel, hostname, uptime, disks) — default 5 s
 */
import { invoke } from "@tauri-apps/api/core";

export interface DiskInfo {
  mountPoint: string;
  filesystem: string;
  totalBytes: number;
  usedBytes: number;
}

export interface GpuInfo {
  index: number;
  name: string;
  /** 0–100 */
  gpuUtil: number;
  /** 0–100 */
  memUtil: number;
  memUsed: number;
  memTotal: number;
  /** °C */
  temperature: number;
  /** Watts */
  powerDraw: number;
  /** 0–100 */
  fanPct: number;
}

/** Network interface throughput (bytes/sec). */
export interface NetInterface {
  name: string;
  /** Receive bytes per second */
  rxBytesSec: number;
  /** Transmit bytes per second */
  txBytesSec: number;
}

/** Fast-changing metrics (CPU, RAM, swap, load, GPU, network). */
export interface FastStats {
  /** 0–100 */
  cpuUsage: number;
  cpuCores: number;
  /** [1m, 5m, 15m] */
  loadAvg: [number, number, number];
  ramTotal: number;
  ramUsed: number;
  swapTotal: number;
  swapUsed: number;
  gpus: GpuInfo[];
  net: NetInterface[];
  /** Name of the interface carrying the default route (e.g. "eth0") */
  defaultIface: string | null;
}

/** Slow-changing metrics (OS, disks, uptime). */
export interface SlowStats {
  osInfo: string;
  kernel: string;
  hostname: string;
  uptimeSecs: number;
  disks: DiskInfo[];
}

/** Legacy combined response. */
export interface RemoteStats {
  osInfo: string;
  kernel: string;
  hostname: string;
  /** 0–100 */
  cpuUsage: number;
  cpuCores: number;
  /** [1m, 5m, 15m] */
  loadAvg: [number, number, number];
  ramTotal: number;
  ramUsed: number;
  swapTotal: number;
  swapUsed: number;
  disks: DiskInfo[];
  uptimeSecs: number;
  gpus: GpuInfo[];
}

export const systemApi = {
  /** Legacy combined poll. */
  remoteStats: (runtimeId: string) =>
    invoke<RemoteStats>("remote_stats", { runtimeId }),

  /** Fast metrics: CPU, RAM, swap, load avg, GPU. ~1s interval. */
  fastStats: (runtimeId: string) =>
    invoke<FastStats>("remote_stats_fast", { runtimeId }),

  /** Slow metrics: OS info, kernel, hostname, uptime, disks. ~5s interval. */
  slowStats: (runtimeId: string) =>
    invoke<SlowStats>("remote_stats_slow", { runtimeId }),
};
