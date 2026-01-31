/**
 * Cron job management
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { CRONS_FILE, CRON_HISTORY_FILE } from "../paths.js";
import type { CronJob, CronHistoryEntry } from "../types.js";

const MAX_HISTORY_ENTRIES = 1000; // Keep last 1000 entries

export function getCrons(): CronJob[] {
  return existsSync(CRONS_FILE) ? JSON.parse(readFileSync(CRONS_FILE, "utf-8")) : [];
}

export function saveCrons(crons: CronJob[]): void {
  writeFileSync(CRONS_FILE, JSON.stringify(crons, null, 2));
}

export function addCron(job: CronJob): void {
  const crons = getCrons();
  // Remove existing job with same name
  const filtered = crons.filter(c => c.name !== job.name);
  filtered.push(job);
  saveCrons(filtered);
}

export function removeCron(name: string): boolean {
  const crons = getCrons();
  const filtered = crons.filter(c => c.name !== name);
  if (filtered.length === crons.length) return false;
  saveCrons(filtered);
  return true;
}

export function getCron(name: string): CronJob | undefined {
  return getCrons().find(c => c.name === name);
}

export function parseCronSchedule(schedule: string): {
  minute: number[];
  hour: number[];
  day: number[];
  month: number[];
  weekday: number[]
} {
  const parts = schedule.split(" ");
  if (parts.length !== 5) throw new Error("Invalid cron schedule");

  const parse = (part: string, max: number): number[] => {
    if (part === "*") return Array.from({ length: max }, (_, i) => i);
    if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2));
      return Array.from({ length: max }, (_, i) => i).filter(i => i % step === 0);
    }
    if (part.includes(",")) return part.split(",").map(Number);
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }
    return [parseInt(part)];
  };

  return {
    minute: parse(parts[0], 60),
    hour: parse(parts[1], 24),
    day: parse(parts[2], 32),
    month: parse(parts[3], 13),
    weekday: parse(parts[4], 7),
  };
}

export function shouldRunCron(schedule: string, date: Date): boolean {
  try {
    const cron = parseCronSchedule(schedule);
    return (
      cron.minute.includes(date.getMinutes()) &&
      cron.hour.includes(date.getHours()) &&
      cron.day.includes(date.getDate()) &&
      cron.month.includes(date.getMonth() + 1) &&
      cron.weekday.includes(date.getDay())
    );
  } catch {
    return false;
  }
}

export function parseTimeSpec(spec: string): number {
  const now = Date.now();
  if (spec === "now") return now;

  if (spec.startsWith("+")) {
    const match = spec.match(/^\+(\d+)([smhd])$/);
    if (match) {
      const val = parseInt(match[1]);
      const unit = match[2];
      const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit]!;
      return now + val * mult;
    }
  }

  if (/^\d{10,13}$/.test(spec)) {
    const ts = parseInt(spec);
    return ts < 1e12 ? ts * 1000 : ts;
  }

  if (/^\d{1,2}:\d{2}$/.test(spec)) {
    const [h, m] = spec.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() < now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  const parsed = Date.parse(spec);
  if (!isNaN(parsed)) return parsed;

  throw new Error(`Invalid time spec: ${spec}`);
}

export function createOnceJob(time: string, session: string, message: string): CronJob {
  const runAt = parseTimeSpec(time);
  return {
    name: `once-${Date.now()}`,
    schedule: "once",
    session,
    message,
    once: true,
    runAt,
  };
}

// Cron history functions
export function getCronHistory(options?: {
  name?: string;
  session?: string;
  limit?: number;
  offset?: number;
  since?: number;
  successOnly?: boolean;
  failedOnly?: boolean;
}): { entries: CronHistoryEntry[]; total: number; hasMore: boolean } {
  if (!existsSync(CRON_HISTORY_FILE)) return { entries: [], total: 0, hasMore: false };

  let history: CronHistoryEntry[] = JSON.parse(readFileSync(CRON_HISTORY_FILE, "utf-8"));

  // Filter by name
  if (options?.name) {
    history = history.filter(h => h.name === options.name);
  }

  // Filter by session
  if (options?.session) {
    history = history.filter(h => h.session === options.session);
  }

  // Filter by time
  if (options?.since) {
    const since = options.since;
    history = history.filter(h => h.timestamp >= since);
  }

  // Filter by success/failure
  if (options?.successOnly) {
    history = history.filter(h => h.success);
  } else if (options?.failedOnly) {
    history = history.filter(h => !h.success);
  }

  // Sort by timestamp descending (most recent first)
  history.sort((a, b) => b.timestamp - a.timestamp);

  const total = history.length;
  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? 50;

  // Apply pagination
  const entries = history.slice(offset, offset + limit);
  const hasMore = offset + entries.length < total;

  return { entries, total, hasMore };
}

export function addCronHistory(entry: CronHistoryEntry): void {
  let history: CronHistoryEntry[] = [];

  if (existsSync(CRON_HISTORY_FILE)) {
    history = JSON.parse(readFileSync(CRON_HISTORY_FILE, "utf-8"));
  }

  history.push(entry);

  // Trim to max entries (keep most recent)
  if (history.length > MAX_HISTORY_ENTRIES) {
    history.sort((a, b) => b.timestamp - a.timestamp);
    history = history.slice(0, MAX_HISTORY_ENTRIES);
  }

  writeFileSync(CRON_HISTORY_FILE, JSON.stringify(history, null, 2));
}

export function clearCronHistory(options?: { name?: string; session?: string }): number {
  if (!existsSync(CRON_HISTORY_FILE)) return 0;

  let history: CronHistoryEntry[] = JSON.parse(readFileSync(CRON_HISTORY_FILE, "utf-8"));
  const originalLength = history.length;

  if (options?.name) {
    history = history.filter(h => h.name !== options.name);
  } else if (options?.session) {
    history = history.filter(h => h.session !== options.session);
  } else {
    history = [];
  }

  writeFileSync(CRON_HISTORY_FILE, JSON.stringify(history, null, 2));
  return originalLength - history.length;
}
