/**
 * Zustand store tracking active SFTP transfers (upload / download).
 * Each transfer has progress, status, and can be cancelled.
 */
import { create } from "zustand";

export type TransferDirection = "upload" | "download" | "server-copy" | "scp";
export type TransferStatus = "active" | "done" | "cancelled" | "error";

/** Single speed sample at a given progress percentage. */
export interface SpeedSample {
  /** Progress 0–1 at the time of this sample. */
  pct: number;
  /** Bytes per second. */
  speed: number;
}

export interface Transfer {
  id: string;
  fileName: string;
  direction: TransferDirection;
  bytes: number;
  total: number;
  status: TransferStatus;
  error?: string;
  /** Unix epoch ms when the transfer started. */
  startedAt: number;
  /** Current speed in bytes per second (smoothed). */
  speed: number;
  /** Speed history for the sparkline progress bar. */
  speedHistory: SpeedSample[];
  /** Internal: bytes at last progress update. */
  _prevBytes: number;
  /** Internal: timestamp of last progress update (ms). */
  _prevTime: number;
}

interface TransfersState {
  transfers: Transfer[];
  addTransfer: (
    id: string,
    fileName: string,
    direction: TransferDirection,
    total: number,
  ) => void;
  updateProgress: (id: string, bytes: number, total: number, reportedSpeed?: number) => void;
  markDone: (id: string) => void;
  markCancelled: (id: string) => void;
  markError: (id: string, error: string) => void;
  removeTransfer: (id: string) => void;
  clearCompleted: () => void;
}

export const useTransfersStore = create<TransfersState>((set) => ({
  transfers: [],

  addTransfer: (id, fileName, direction, total) =>
    set((s) => {
      const now = Date.now();
      return {
        transfers: [
          ...s.transfers,
          {
            id,
            fileName,
            direction,
            bytes: 0,
            total,
            status: "active",
            startedAt: now,
            speed: 0,
            speedHistory: [{ pct: 0, speed: 0 }],
            _prevBytes: 0,
            _prevTime: now,
          },
        ],
      };
    }),

  updateProgress: (id, bytes, total, reportedSpeed) =>
    set((s) => ({
      transfers: s.transfers.map((t) => {
        if (t.id !== id) return t;
        const now = Date.now();
        const pct = total > 0 ? bytes / total : 0;

        // If the caller provides a speed (e.g. parsed from rsync), use it directly.
        if (reportedSpeed != null && reportedSpeed > 0) {
          const speedHistory = [...t.speedHistory, { pct, speed: reportedSpeed }];
          return { ...t, bytes, total, speed: reportedSpeed, speedHistory, _prevBytes: bytes, _prevTime: now };
        }

        // Otherwise compute from byte deltas.
        const dt = (now - t._prevTime) / 1000;
        const db = bytes - t._prevBytes;
        if (dt >= 0.25) {
          const instantSpeed = db / dt;
          const speed = t.speed === 0 ? instantSpeed : t.speed * 0.7 + instantSpeed * 0.3;
          const speedHistory = [...t.speedHistory, { pct, speed }];
          return { ...t, bytes, total, speed, speedHistory, _prevBytes: bytes, _prevTime: now };
        }
        return { ...t, bytes, total };
      }),
    })),

  markDone: (id) =>
    set((s) => ({
      transfers: s.transfers.map((t) => {
        if (t.id !== id) return t;
        const lastSpeed = t.speedHistory.length > 0 ? t.speedHistory[t.speedHistory.length - 1].speed : 0;
        return {
          ...t,
          status: "done" as const,
          bytes: t.total,
          speedHistory: [...t.speedHistory, { pct: 1, speed: lastSpeed }],
        };
      }),
    })),

  markCancelled: (id) =>
    set((s) => ({
      transfers: s.transfers.map((t) =>
        t.id === id ? { ...t, status: "cancelled" as const } : t,
      ),
    })),

  markError: (id, error) =>
    set((s) => ({
      transfers: s.transfers.map((t) =>
        t.id === id ? { ...t, status: "error" as const, error } : t,
      ),
    })),

  removeTransfer: (id) =>
    set((s) => ({
      transfers: s.transfers.filter((t) => t.id !== id),
    })),

  clearCompleted: () =>
    set((s) => ({
      transfers: s.transfers.filter((t) => t.status === "active"),
    })),
}));
