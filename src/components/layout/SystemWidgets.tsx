import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownUp, CircuitBoard, Cpu, HardDrive, MemoryStick, Monitor, Clock } from "lucide-react";

import type { DiskInfo, FastStats, SlowStats } from "@/api/system";
import { systemApi } from "@/api/system";
import { settingsApi } from "@/api/settings";
import { useTabsStore } from "@/stores/tabs";

/** How many data points to keep for sparkline history. */
const HISTORY_LEN = 60;

/** Default intervals (ms). */
const DEFAULT_FAST_MS = 1000;
const DEFAULT_SLOW_MS = 5000;

// ── Helpers ──────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  if (gb < 100) return `${gb.toFixed(1)} GB`;
  return `${gb.toFixed(0)} GB`;
}

function formatUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  const kb = bytesPerSec / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB/s`;
  const mb = kb / 1024;
  if (mb < 100) return `${mb.toFixed(1)} MB/s`;
  return `${mb.toFixed(0)} MB/s`;
}

function pct(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 100) : 0;
}

// ── Sparkline (right-aligned timeline) ──────────────────────────────────
//
// Points accumulate from right to left. When fewer than HISTORY_LEN
// points exist the chart area is right-aligned so that the latest
// value is always at the right edge.

interface SparklineProps {
  data: number[];
  /** Scale ceiling. For 0–100 metrics pass 100; for auto-scale pass undefined. */
  max?: number;
  color: string;
  width?: number;
  height?: number;
}

function Sparkline({
  data,
  max,
  color,
  width = 44,
  height = 14,
}: SparklineProps) {
  if (data.length < 2) return null;

  const clamp = max ?? Math.max(...data, 1);
  // Each step occupies a fixed pixel width so the scroll speed is constant.
  const step = width / (HISTORY_LEN - 1);
  const pts = data.map((v, i) => {
    // right-align: last element is at x = width
    const x = width - (data.length - 1 - i) * step;
    const y = height - (Math.min(v, clamp) / clamp) * (height - 1) - 0.5;
    return [x.toFixed(1), y.toFixed(1)];
  });

  const line = pts.map((p) => p.join(",")).join(" ");
  // Area polygon: start at bottom-left of first point, trace line, drop to bottom-right
  const firstX = pts[0][0];
  const lastX = pts[pts.length - 1][0];
  const area = `M${firstX},${height} L${pts.map((p) => p.join(",")).join(" L")} L${lastX},${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0"
    >
      <path d={area} fill={color} opacity={0.15} />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth={1.2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Widget wrapper with tooltip ──────────────────────────────────────────

interface WidgetProps {
  icon: React.ReactNode;
  label: string;
  chart?: React.ReactNode;
  tooltip?: React.ReactNode;
  /** Extra classes on the label span (e.g. min-w / text-right to prevent layout shift). */
  labelClassName?: string;
}

function Widget({ icon, label, chart, tooltip, labelClassName }: WidgetProps) {
  const [showTip, setShowTip] = useState(false);

  return (
    <div
      className="relative flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-fg-muted/10"
      onMouseEnter={() => setShowTip(true)}
      onMouseLeave={() => setShowTip(false)}
    >
      {icon}
      {chart}
      <span className={`tabular-nums ${labelClassName ?? ""}`}>{label}</span>
      {showTip && tooltip && (
        <div className="absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border-subtle bg-bg-elevated px-3 py-2 text-[10px] shadow-lg">
          {tooltip}
        </div>
      )}
    </div>
  );
}

// ── Main exported component ──────────────────────────────────────────────

export function SystemWidgets() {
  const runtimeId = useTabsStore((s) => {
    const { focusedPaneId, paneRuntimeIds } = s;
    return focusedPaneId ? (paneRuntimeIds[focusedPaneId] ?? null) : null;
  });

  const [fast, setFast] = useState<FastStats | null>(null);
  const [slow, setSlow] = useState<SlowStats | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [ramHistory, setRamHistory] = useState<number[]>([]);
  const [gpuHistory, setGpuHistory] = useState<number[]>([]);
  /** Per-interface history: Map<ifaceName, {rx: number[], tx: number[]}> */
  const [netHistory, setNetHistory] = useState<Record<string, { rx: number[]; tx: number[] }>>({});

  // Configurable intervals
  const [fastMs, setFastMs] = useState(DEFAULT_FAST_MS);
  const [slowMs, setSlowMs] = useState(DEFAULT_SLOW_MS);

  // Load user-configured intervals once
  useEffect(() => {
    void (async () => {
      const [fv, sv] = await Promise.all([
        settingsApi.get("monitoring.fastIntervalMs"),
        settingsApi.get("monitoring.slowIntervalMs"),
      ]);
      if (fv) {
        const n = parseInt(fv, 10);
        if (n >= 500) setFastMs(n);
      }
      if (sv) {
        const n = parseInt(sv, 10);
        if (n >= 1000) setSlowMs(n);
      }
    })();
  }, []);

  // Reset history when switching sessions
  const prevRid = useRef(runtimeId);
  useEffect(() => {
    if (runtimeId !== prevRid.current) {
      prevRid.current = runtimeId;
      setFast(null);
      setSlow(null);
      setCpuHistory([]);
      setRamHistory([]);
      setGpuHistory([]);
      setNetHistory({});
    }
  }, [runtimeId]);

  // Fast poll (CPU, RAM, GPU, Net)
  const pollFast = useCallback(async (rid: string) => {
    try {
      const s = await systemApi.fastStats(rid);
      setFast(s);
      setCpuHistory((h) => [...h.slice(-(HISTORY_LEN - 1)), s.cpuUsage]);
      setRamHistory((h) => [
        ...h.slice(-(HISTORY_LEN - 1)),
        pct(s.ramUsed, s.ramTotal),
      ]);
      if (s.gpus.length > 0) {
        setGpuHistory((h) => [...h.slice(-(HISTORY_LEN - 1)), s.gpus[0].gpuUtil]);
      }
      // Network history per interface + _busiest (highest rx+tx)
      if (s.net.length > 0) {
        setNetHistory((prev) => {
          const next = { ...prev };
          let best = s.net[0];
          for (const iface of s.net) {
            const existing = next[iface.name] ?? { rx: [], tx: [] };
            next[iface.name] = {
              rx: [...existing.rx.slice(-(HISTORY_LEN - 1)), iface.rxBytesSec],
              tx: [...existing.tx.slice(-(HISTORY_LEN - 1)), iface.txBytesSec],
            };
            if (iface.rxBytesSec + iface.txBytesSec > best.rxBytesSec + best.txBytesSec) {
              best = iface;
            }
          }
          const tot = next["_total"] ?? { rx: [], tx: [] };
          next["_total"] = {
            rx: [...tot.rx.slice(-(HISTORY_LEN - 1)), best.rxBytesSec],
            tx: [...tot.tx.slice(-(HISTORY_LEN - 1)), best.txBytesSec],
          };
          return next;
        });
      }
    } catch {
      // session may be disconnecting
    }
  }, []);

  // Slow poll (OS, disks, uptime)
  const pollSlow = useCallback(async (rid: string) => {
    try {
      const s = await systemApi.slowStats(rid);
      setSlow(s);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!runtimeId) return;
    let alive = true;
    const rid = runtimeId;

    // Kick off initial polls
    void pollFast(rid);
    void pollSlow(rid);

    const fastId = setInterval(() => {
      if (alive) void pollFast(rid);
    }, fastMs);

    const slowId = setInterval(() => {
      if (alive) void pollSlow(rid);
    }, slowMs);

    return () => {
      alive = false;
      clearInterval(fastId);
      clearInterval(slowId);
    };
  }, [runtimeId, fastMs, slowMs, pollFast, pollSlow]);

  if (!fast || !slow || !runtimeId) return null;

  const cpuPct = Math.round(fast.cpuUsage);
  const ramPct = pct(fast.ramUsed, fast.ramTotal);

  // Aggregate disks
  const mainDisks = slow.disks.filter((d) => d.totalBytes > 500_000_000);
  const worstDiskPct = mainDisks.reduce((max, d) => {
    const p = pct(d.usedBytes, d.totalBytes);
    return p > max ? p : max;
  }, 0);

  // Network: pick default-gw interface, fallback to first
  const defaultIfaceName = fast.defaultIface ?? (fast.net.length > 0 ? fast.net[0].name : null);
  const defaultIface = fast.net.find((n) => n.name === defaultIfaceName) ?? null;

  const iconClass = "h-3 w-3 text-fg-subtle";

  return (
    <div className="flex items-center gap-0.5">
      {/* Remote host info */}
      <Widget
        icon={<Monitor className={iconClass} />}
        label={slow.hostname}
        tooltip={
          <div className="flex flex-col gap-0.5 text-fg-muted">
            <span>{slow.osInfo}</span>
            <span>Kernel {slow.kernel}</span>
            <span>
              Load: {fast.loadAvg[0].toFixed(2)} / {fast.loadAvg[1].toFixed(2)} /{" "}
              {fast.loadAvg[2].toFixed(2)}
            </span>
          </div>
        }
      />

      <Separator />

      {/* Uptime */}
      <Widget
        icon={<Clock className={iconClass} />}
        label={formatUptime(slow.uptimeSecs)}
        labelClassName="min-w-[6ch] text-right"
      />

      <Separator />

      {/* CPU */}
      <Widget
        icon={<Cpu className={iconClass} />}
        label={`${cpuPct}%`}
        labelClassName="min-w-[4ch] text-right"
        chart={<Sparkline data={cpuHistory} max={100} color="#60a5fa" />}
        tooltip={
          <div className="text-fg-muted">
            CPU: {cpuPct}% · {fast.cpuCores} cores · Load{" "}
            {fast.loadAvg[0].toFixed(2)}
          </div>
        }
      />

      {/* RAM */}
      <Widget
        icon={<MemoryStick className={iconClass} />}
        label={`${ramPct}%`}
        labelClassName="min-w-[4ch] text-right"
        chart={<Sparkline data={ramHistory} max={100} color="#a78bfa" />}
        tooltip={
          <div className="flex flex-col gap-0.5 text-fg-muted">
            <span>
              RAM: {formatBytes(fast.ramUsed)} / {formatBytes(fast.ramTotal)} ({ramPct}
              %)
            </span>
            {fast.swapTotal > 0 && (
              <span>
                Swap: {formatBytes(fast.swapUsed)} /{" "}
                {formatBytes(fast.swapTotal)} (
                {pct(fast.swapUsed, fast.swapTotal)}%)
              </span>
            )}
          </div>
        }
      />

      {/* Disks */}
      {mainDisks.length > 0 && (
        <Widget
          icon={<HardDrive className={iconClass} />}
          label={`${worstDiskPct}%`}
          labelClassName="min-w-[4ch] text-right"
          chart={<DiskBars disks={mainDisks} />}
          tooltip={<DiskTooltip disks={mainDisks} />}
        />
      )}

      {/* GPU (NVIDIA) */}
      {fast.gpus.length > 0 && (
        <>
          <Separator />
          {fast.gpus.map((gpu) => {
            const gpuPct = Math.round(gpu.gpuUtil);
            const vramPct = pct(gpu.memUsed, gpu.memTotal);
            return (
              <Widget
                key={gpu.index}
                icon={<CircuitBoard className={iconClass} />}
                label={`${gpuPct}%`}
                labelClassName="min-w-[4ch] text-right"
                chart={
                  <Sparkline
                    data={gpu.index === 0 ? gpuHistory : [gpuPct]}
                    max={100}
                    color="#4ade80"
                  />
                }
                tooltip={
                  <div className="flex flex-col gap-0.5 text-fg-muted">
                    <span className="font-medium text-fg">{gpu.name}</span>
                    <span>GPU: {gpuPct}%  ·  VRAM: {formatBytes(gpu.memUsed)}/{formatBytes(gpu.memTotal)} ({vramPct}%)</span>
                    <span>Temp: {gpu.temperature}°C  ·  Power: {gpu.powerDraw.toFixed(0)}W{gpu.fanPct > 0 ? `  ·  Fan: ${gpu.fanPct}%` : ""}</span>
                  </div>
                }
              />
            );
          })}
        </>
      )}

      {/* Network — shows total rx/tx across all interfaces, tooltip shows per-iface */}
      {fast.net.length > 0 && (
        <>
          <Separator />
          <NetWidget
            defaultIface={defaultIface}
            allIfaces={fast.net}
            netHistory={netHistory}
          />
        </>
      )}
    </div>
  );
}

// ── Network widget (single, with all-interfaces tooltip) ─────────────────

interface NetWidgetProps {
  defaultIface: { name: string; rxBytesSec: number; txBytesSec: number } | null;
  allIfaces: { name: string; rxBytesSec: number; txBytesSec: number }[];
  netHistory: Record<string, { rx: number[]; tx: number[] }>;
}

/** Max interfaces shown in the tooltip. */
const MAX_NET_IFACES = 32;

function NetWidget({ defaultIface, allIfaces, netHistory }: NetWidgetProps) {
  const [showTip, setShowTip] = useState(false);

  // Pick the busiest interface (highest rx+tx) to avoid double-counting
  // through bridge/veth/docker interfaces that mirror the same traffic.
  let busiest = allIfaces[0] ?? { name: "", rxBytesSec: 0, txBytesSec: 0 };
  for (const iface of allIfaces) {
    if (iface.rxBytesSec + iface.txBytesSec > busiest.rxBytesSec + busiest.txBytesSec) {
      busiest = iface;
    }
  }
  const totalRx = busiest.rxBytesSec;
  const totalTx = busiest.txBytesSec;

  const iconClass = "h-3 w-3 text-fg-subtle";

  // Stable sort: default-gw first, then alphabetical. Limit to MAX_NET_IFACES.
  const gwName = defaultIface?.name;
  const sorted = [...allIfaces]
    .sort((a, b) => {
      if (gwName && a.name === gwName) return -1;
      if (gwName && b.name === gwName) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, MAX_NET_IFACES);

  // Multi-column: up to 8 per column
  const PER_COL = 8;
  const cols = Math.ceil(sorted.length / PER_COL);

  return (
    <div
      className="relative flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-fg-muted/10"
      onMouseEnter={() => setShowTip(true)}
      onMouseLeave={() => setShowTip(false)}
    >
      <ArrowDownUp className={iconClass} />
      {(() => {
        const th = netHistory["_total"];
        const rxHist = th?.rx ?? [];
        const maxRx = Math.max(...rxHist, 1024);
        return <Sparkline data={rxHist} max={maxRx} color="#22d3ee" />;
      })()}
      <span className="tabular-nums text-fg-muted">↓</span>
      <span className="min-w-[6ch] text-right tabular-nums">{formatSpeed(totalRx)}</span>
      {(() => {
        const th = netHistory["_total"];
        const txHist = th?.tx ?? [];
        const maxTx = Math.max(...txHist, 1024);
        return <Sparkline data={txHist} max={maxTx} color="#a78bfa" />;
      })()}
      <span className="tabular-nums text-fg-muted">↑</span>
      <span className="min-w-[6ch] text-right tabular-nums">{formatSpeed(totalTx)}</span>
      {showTip && (
        <div className="absolute bottom-full right-0 z-50 mb-2 rounded-lg border border-border-subtle bg-bg-elevated px-3 py-2.5 text-[10px] shadow-lg">
          <div className="flex gap-4" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {Array.from({ length: cols }, (_, col) => (
              <div key={col} className="flex flex-col gap-2">
                {sorted.slice(col * PER_COL, (col + 1) * PER_COL).map((iface) => {
                  const h = netHistory[iface.name];
                  const rxHist = h?.rx ?? [];
                  const txHist = h?.tx ?? [];
                  const comb = rxHist.map((r, i) => r + (txHist[i] ?? 0));
                  const mx = Math.max(...comb, 1024);
                  const isDefault = gwName != null && iface.name === gwName;
                  return (
                    <div key={iface.name} className="flex flex-col gap-0.5">
                      <span className={`whitespace-nowrap font-medium ${isDefault ? "text-fg" : "text-fg-muted"}`}>
                        {iface.name}
                        {isDefault && <span className="ml-1 text-[9px] opacity-50">gw</span>}
                      </span>
                      <div className="flex items-center gap-2">
                        <Sparkline data={comb} max={mx} color="#38bdf8" width={80} height={20} />
                        <div className="flex flex-col whitespace-nowrap text-fg-muted">
                          <span>↓ {formatSpeed(iface.rxBytesSec)}</span>
                          <span>↑ {formatSpeed(iface.txBytesSec)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {allIfaces.length > MAX_NET_IFACES && (
            <div className="mt-1.5 text-center text-[9px] text-fg-subtle">
              +{allIfaces.length - MAX_NET_IFACES} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Separator() {
  return <span className="mx-0.5 text-border-subtle">|</span>;
}

function DiskBars({ disks }: { disks: DiskInfo[] }) {
  return (
    <div className="flex h-3.5 w-10 items-end gap-px">
      {disks.slice(0, 6).map((d) => {
        const p = pct(d.usedBytes, d.totalBytes);
        return (
          <div
            key={d.mountPoint}
            className="flex-1 rounded-sm"
            style={{
              height: `${Math.max(p, 8)}%`,
              backgroundColor:
                p > 90 ? "#f87171" : p > 70 ? "#fbbf24" : "#34d399",
              opacity: 0.8,
            }}
          />
        );
      })}
    </div>
  );
}

function DiskTooltip({ disks }: { disks: DiskInfo[] }) {
  return (
    <div className="flex flex-col gap-1">
      {disks.map((d) => {
        const p = pct(d.usedBytes, d.totalBytes);
        return (
          <div
            key={d.mountPoint}
            className="flex items-center gap-2 text-fg-muted"
          >
            <span className="w-20 truncate" title={d.mountPoint}>
              {d.mountPoint}
            </span>
            <div className="h-1.5 w-16 rounded-full bg-fg-muted/20">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${p}%`,
                  backgroundColor:
                    p > 90 ? "#f87171" : p > 70 ? "#fbbf24" : "#34d399",
                }}
              />
            </div>
            <span className="tabular-nums">
              {formatBytes(d.usedBytes)}/{formatBytes(d.totalBytes)} ({p}%)
            </span>
          </div>
        );
      })}
    </div>
  );
}
