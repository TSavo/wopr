/**
 * Cron job management
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { CRONS_FILE } from "../paths.js";
import type { CronJob } from "../types.js";

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
