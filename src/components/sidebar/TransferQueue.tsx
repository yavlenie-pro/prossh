/**
 * Transfer queue panel — shows at the bottom of the sidebar when there are
 * active or recent transfers. The progress bar is rendered as an area chart
 * of transfer speed over progress percentage — a visual "speed profile" that
 * doubles as a progress indicator.
 */
import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  RefreshCw,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { sftpApi } from "@/api/sftp";
import {
  useTransfersStore,
  type Transfer,
  type TransferStatus,
  type SpeedSample,
} from "@/stores/transfers";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function formatSpeed(bytesPerSec: number) {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1048576) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  if (bytesPerSec < 1073741824) return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
  return `${(bytesPerSec / 1073741824).toFixed(2)} GB/s`;
}

function formatElapsed(startedAt: number) {
  const sec = Math.floor((Date.now() - startedAt) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  if (min < 60) return `${min}m ${s}s`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

// ── Speed chart (replaces flat progress bar) ────────────────────────────

const CHART_W = 200;
const CHART_H = 20;

function statusStroke(status: TransferStatus): string {
  switch (status) {
    case "active":
      return "var(--color-accent, #60a5fa)";
    case "done":
      return "#22c55e";
    case "cancelled":
      return "#eab308";
    case "error":
      return "#ef4444";
  }
}

function SpeedChart({
  samples,
  status,
  pct,
}: {
  samples: SpeedSample[];
  status: TransferStatus;
  pct: number; // 0–1
}) {
  const stroke = statusStroke(status);

  // Find the peak speed for Y-axis scaling
  let maxSpeed = 0;
  for (const s of samples) {
    if (s.speed > maxSpeed) maxSpeed = s.speed;
  }
  // Avoid division by zero; give a little headroom
  if (maxSpeed === 0) maxSpeed = 1;
  const yScale = maxSpeed * 1.15;

  // Build points: X = pct (0→CHART_W), Y = speed (top=max, bottom=0)
  // Start with bottom-left
  const areaPoints: string[] = [`0,${CHART_H}`];
  const linePoints: string[] = [];

  if (samples.length <= 1) {
    // Not enough data — just draw flat progress
    areaPoints.push(`0,${CHART_H - 1}`);
    const xEnd = pct * CHART_W;
    areaPoints.push(`${xEnd.toFixed(1)},${CHART_H - 1}`);
    areaPoints.push(`${xEnd.toFixed(1)},${CHART_H}`);
    linePoints.push(`0,${CHART_H - 1}`);
    linePoints.push(`${xEnd.toFixed(1)},${CHART_H - 1}`);
  } else {
    for (const s of samples) {
      const x = s.pct * CHART_W;
      const y = CHART_H - (s.speed / yScale) * (CHART_H - 1) - 0.5;
      const pt = `${x.toFixed(1)},${y.toFixed(1)}`;
      areaPoints.push(pt);
      linePoints.push(pt);
    }
    // Close the area polygon back to baseline
    const lastX = (samples[samples.length - 1].pct * CHART_W).toFixed(1);
    areaPoints.push(`${lastX},${CHART_H}`);
  }

  const areaPath = `M${areaPoints.join(" L")} Z`;

  return (
    <div className="relative">
      <svg
        width="100%"
        height={CHART_H}
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="none"
        className="block w-full rounded"
        style={{ backgroundColor: "var(--color-border-subtle, #333)" }}
      >
        {/* Unfilled portion (dimmed background) */}
        <rect x={0} y={0} width={CHART_W} height={CHART_H} fill="transparent" />

        {/* Filled area = speed graph */}
        <path d={areaPath} fill={stroke} opacity={0.25} />

        {/* Line on top */}
        {linePoints.length >= 2 && (
          <polyline
            points={linePoints.join(" ")}
            fill="none"
            stroke={stroke}
            strokeWidth={1.2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* Thin progress cursor line */}
        {status === "active" && pct > 0 && pct < 1 && (
          <line
            x1={pct * CHART_W}
            y1={0}
            x2={pct * CHART_W}
            y2={CHART_H}
            stroke={stroke}
            strokeWidth={1}
            opacity={0.6}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </div>
  );
}

// ── Indeterminate progress bar for SCP ──────────────────────────────────

function IndeterminateBar({ status }: { status: TransferStatus }) {
  const color = statusStroke(status);
  return (
    <div
      className="relative h-[20px] w-full overflow-hidden rounded"
      style={{ backgroundColor: "var(--color-border-subtle, #333)" }}
    >
      {status === "active" ? (
        <div
          className="absolute inset-y-0 w-1/3 animate-indeterminate rounded"
          style={{ background: `linear-gradient(90deg, transparent, ${color}, transparent)` }}
        />
      ) : (
        <div
          className="absolute inset-y-0 left-0 w-full rounded"
          style={{ backgroundColor: color, opacity: 0.25 }}
        />
      )}
    </div>
  );
}

// ── Transfer row ────────────────────────────────────────────────────────

function TransferRow({ transfer }: { transfer: Transfer }) {
  const { t } = useTranslation();
  const removeTransfer = useTransfersStore((s) => s.removeTransfer);
  const pct =
    transfer.total > 0
      ? Math.min(1, transfer.bytes / transfer.total)
      : 0;

  // Tick every second so elapsed time updates for SCP transfers
  const [, setTick] = useState(0);
  useEffect(() => {
    if (transfer.direction !== "scp" || transfer.status !== "active") return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [transfer.direction, transfer.status]);

  const handleCancel = () => {
    void sftpApi.cancelTransfer(transfer.id);
  };

  return (
    <div className="group px-2 py-1.5">
      {/* Top line: icon + name + speed + action */}
      <div className="flex items-center gap-1.5">
        {transfer.direction === "scp" ? (
          <RefreshCw className={`h-3 w-3 shrink-0 text-accent${transfer.status === "active" ? " animate-spin" : ""}`} />
        ) : transfer.direction === "upload" || transfer.direction === "server-copy" ? (
          <ArrowUpFromLine className="h-3 w-3 shrink-0 text-accent" />
        ) : (
          <ArrowDownToLine className="h-3 w-3 shrink-0 text-accent" />
        )}
        <span className="min-w-0 flex-1 truncate text-[11px] text-fg">
          {transfer.fileName}
        </span>
        {transfer.status === "active" && (
          <span className="shrink-0 text-[9px] tabular-nums text-fg-subtle">
            {transfer.direction === "scp"
              ? formatElapsed(transfer.startedAt)
              : formatSpeed(transfer.speed)}
          </span>
        )}
        {transfer.status === "active" ? (
          <button
            type="button"
            onClick={handleCancel}
            className="rounded p-0.5 text-fg-subtle opacity-0 hover:text-danger group-hover:opacity-100"
            title={t("files.cancelTransfer")}
          >
            <XCircle className="h-3 w-3" />
          </button>
        ) : transfer.status === "done" ? (
          <Check className="h-3 w-3 shrink-0 text-green-500" />
        ) : transfer.status === "cancelled" ? (
          <X className="h-3 w-3 shrink-0 text-yellow-500" />
        ) : (
          <X className="h-3 w-3 shrink-0 text-danger" />
        )}
        {transfer.status !== "active" && (
          <button
            type="button"
            onClick={() => removeTransfer(transfer.id)}
            className="rounded p-0.5 text-fg-subtle opacity-0 hover:text-fg group-hover:opacity-100"
            title={t("files.removeFromList")}
          >
            <Trash2 className="h-2.5 w-2.5" />
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className="mt-1">
        {transfer.direction === "scp" && transfer.bytes === 0 ? (
          <IndeterminateBar status={transfer.status} />
        ) : (
          <SpeedChart
            samples={transfer.speedHistory}
            status={transfer.status}
            pct={pct}
          />
        )}
      </div>

      {/* Bottom info line */}
      <div className="mt-0.5 flex items-center justify-between">
        <span
          className={`text-[9px] tabular-nums ${transfer.status === "error" ? "text-danger" : "text-fg-subtle"}`}
          title={transfer.status === "error" && transfer.error ? transfer.error : undefined}
        >
          {transfer.status === "done"
            ? transfer.direction === "scp" ? t("files.scpDone") : formatSize(transfer.total)
            : transfer.status === "cancelled"
              ? t("files.transferCancelled")
              : transfer.status === "error"
                ? transfer.error
                  ? `${t("files.transferError")}: ${transfer.error}`
                  : t("files.transferError")
                : transfer.status === "active"
                  ? transfer.bytes > 0
                    ? `${formatSize(transfer.bytes)} / ${formatSize(transfer.total)}${transfer.speed > 0 ? `  ${formatSpeed(transfer.speed)}` : ""}`
                    : transfer.direction === "scp"
                      ? t("files.scpRunning")
                      : `${formatSize(transfer.bytes)} / ${formatSize(transfer.total)}`
                  : ""}
        </span>
        <span className="text-[9px] tabular-nums text-fg-subtle">
          {transfer.status === "active" && transfer.bytes > 0 && transfer.total > 0
            ? `${Math.round(pct * 100)}%`
            : transfer.status === "active"
              ? formatElapsed(transfer.startedAt)
              : ""}
        </span>
      </div>
    </div>
  );
}

// ── Queue container ─────────────────────────────────────────────────────

export function TransferQueue() {
  const { t } = useTranslation();
  const transfers = useTransfersStore((s) => s.transfers);
  const clearCompleted = useTransfersStore((s) => s.clearCompleted);

  if (transfers.length === 0) return null;

  const hasCompleted = transfers.some((t) => t.status !== "active");

  return (
    <div className="border-t border-border-subtle">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-[10px] font-medium uppercase tracking-wider text-fg-muted">
          {t("files.transfers")}
        </span>
        {hasCompleted && (
          <button
            type="button"
            onClick={clearCompleted}
            className="text-[10px] text-fg-subtle hover:text-fg"
          >
            {t("files.clearCompleted")}
          </button>
        )}
      </div>
      <div className="max-h-52 overflow-y-auto">
        {transfers.map((transfer) => (
          <TransferRow key={transfer.id} transfer={transfer} />
        ))}
      </div>
    </div>
  );
}
