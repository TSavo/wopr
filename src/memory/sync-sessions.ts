// Session file sync - indexes session transcripts for search
// Adapted from OpenClaw for WOPR
import type { DatabaseSync } from "node:sqlite";
import { listSessionFiles, buildSessionEntry, sessionPathForFile, type SessionFileEntry } from "./session-files.js";

export async function syncSessionFiles(params: {
  db: DatabaseSync;
  needsFullReindex: boolean;
  vectorTable: string;
  ftsTable: string;
  ftsEnabled: boolean;
  ftsAvailable: boolean;
  model: string;
  dirtyFiles: Set<string>;
  runWithConcurrency: <T>(tasks: Array<() => Promise<T>>, concurrency: number) => Promise<T[]>;
  indexSessionFile: (entry: SessionFileEntry) => Promise<void>;
  concurrency: number;
}): Promise<void> {
  const files = await listSessionFiles();
  const activePaths = new Set(files.map((file) => sessionPathForFile(file)));
  const indexAll = params.needsFullReindex || params.dirtyFiles.size === 0;

  const tasks = files.map((absPath) => async () => {
    if (!indexAll && !params.dirtyFiles.has(absPath)) {
      return;
    }
    const entry = await buildSessionEntry(absPath);
    if (!entry) {
      return;
    }
    const record = params.db
      .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
      .get(entry.path, "sessions") as { hash: string } | undefined;
    if (!params.needsFullReindex && record?.hash === entry.hash) {
      return;
    }
    await params.indexSessionFile(entry);
  });

  await params.runWithConcurrency(tasks, params.concurrency);

  // Remove stale session entries
  const staleRows = params.db
    .prepare(`SELECT path FROM files WHERE source = ?`)
    .all("sessions") as Array<{ path: string }>;
  for (const stale of staleRows) {
    if (activePaths.has(stale.path)) {
      continue;
    }
    params.db
      .prepare(`DELETE FROM files WHERE path = ? AND source = ?`)
      .run(stale.path, "sessions");
    try {
      params.db
        .prepare(
          `DELETE FROM ${params.vectorTable} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
        )
        .run(stale.path, "sessions");
    } catch {}
    params.db
      .prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`)
      .run(stale.path, "sessions");
    if (params.ftsEnabled && params.ftsAvailable) {
      try {
        params.db
          .prepare(`DELETE FROM ${params.ftsTable} WHERE path = ? AND source = ? AND model = ?`)
          .run(stale.path, "sessions", params.model);
      } catch {}
    }
  }
}
