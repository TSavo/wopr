// sqlite-vec extension loader - copied from OpenClaw
import type { DatabaseSync } from "node:sqlite";

// sqlite-vec module type
interface SqliteVecModule {
  getLoadablePath(): string;
  load(db: DatabaseSync): void;
}

export async function loadSqliteVecExtension(params: {
  db: DatabaseSync;
  extensionPath?: string;
}): Promise<{ ok: boolean; extensionPath?: string; error?: string }> {
  try {
    // Dynamic import to avoid TypeScript module resolution issues
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = await (Function('return import("sqlite-vec")')() as Promise<SqliteVecModule>);
    const resolvedPath = params.extensionPath?.trim() ? params.extensionPath.trim() : undefined;
    const extensionPath = resolvedPath ?? sqliteVec.getLoadablePath();

    params.db.enableLoadExtension(true);
    if (resolvedPath) {
      params.db.loadExtension(extensionPath);
    } else {
      sqliteVec.load(params.db);
    }

    return { ok: true, extensionPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
