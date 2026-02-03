// MemoryIndexManager - adapted from OpenClaw for WOPR
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { WOPR_HOME } from "../paths.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderResult,
  type GeminiEmbeddingClient,
  type OpenAiEmbeddingClient,
} from "./embeddings.js";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid.js";
import {
  buildFileEntry,
  chunkMarkdown,
  ensureDir,
  hashText,
  listMemoryFiles,
  type MemoryChunk,
  type MemoryFileEntry,
} from "./internal.js";
import { searchKeyword, searchVector } from "./search.js";
import { ensureMemoryIndexSchema } from "./schema.js";
import { loadSqliteVecExtension } from "./sqlite-vec.js";
import { syncSessionFiles } from "./sync-sessions.js";
import { type SessionFileEntry } from "./session-files.js";
import { type MemoryConfig, type MemorySearchResult, type MemorySource, DEFAULT_MEMORY_CONFIG } from "./types.js";

const META_KEY = "memory_index_meta_v1";
const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const VECTOR_LOAD_TIMEOUT_MS = 30_000;
const EMBEDDING_QUERY_TIMEOUT_MS = 60_000;
const EMBEDDING_INDEX_CONCURRENCY = 4;

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

type MemoryIndexMeta = {
  model: string;
  provider: string;
  providerKey?: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorDims?: number;
};

export class MemoryIndexManager {
  private readonly globalDir: string;
  private readonly sessionDir: string;
  private readonly config: MemoryConfig;
  private provider: EmbeddingProvider;
  private readonly requestedProvider: "openai" | "local" | "gemini" | "auto";
  private fallbackFrom?: "openai" | "local" | "gemini";
  private fallbackReason?: string;
  private openAi?: OpenAiEmbeddingClient;
  private gemini?: GeminiEmbeddingClient;
  private db: DatabaseSync;
  private readonly sources: Set<MemorySource>;
  private providerKey: string;
  private readonly cache: { enabled: boolean; maxEntries?: number };
  private readonly vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  private readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  };
  private vectorReady: Promise<boolean> | null = null;
  private closed = false;
  private dirty = false;
  private syncing: Promise<void> | null = null;

  static async create(params: {
    globalDir: string;
    sessionDir: string;
    config?: Partial<MemoryConfig>;
  }): Promise<MemoryIndexManager> {
    const config = { ...DEFAULT_MEMORY_CONFIG, ...params.config };

    // Set default store path if not provided
    if (!config.store.path) {
      config.store.path = path.join(WOPR_HOME, "memory", "index.sqlite");
    }

    const providerResult = await createEmbeddingProvider({
      provider: config.provider,
      remote: config.remote,
      model: config.model,
      fallback: config.fallback,
      local: config.local,
    });

    return new MemoryIndexManager({
      globalDir: params.globalDir,
      sessionDir: params.sessionDir,
      config,
      providerResult,
    });
  }

  private constructor(params: {
    globalDir: string;
    sessionDir: string;
    config: MemoryConfig;
    providerResult: EmbeddingProviderResult;
  }) {
    this.globalDir = params.globalDir;
    this.sessionDir = params.sessionDir;
    this.config = params.config;
    this.provider = params.providerResult.provider;
    this.requestedProvider = params.providerResult.requestedProvider;
    this.fallbackFrom = params.providerResult.fallbackFrom;
    this.fallbackReason = params.providerResult.fallbackReason;
    this.openAi = params.providerResult.openAi;
    this.gemini = params.providerResult.gemini;
    this.sources = new Set(["global", "session", "sessions"] as MemorySource[]);
    this.db = this.openDatabase();
    this.providerKey = this.computeProviderKey();
    this.cache = {
      enabled: params.config.cache.enabled,
      maxEntries: params.config.cache.maxEntries,
    };
    this.fts = { enabled: params.config.hybrid.enabled, available: false };
    this.ensureSchema();
    this.vector = {
      enabled: params.config.store.vector.enabled,
      available: null,
      extensionPath: params.config.store.vector.extensionPath,
    };
    const meta = this.readMeta();
    if (meta?.vectorDims) {
      this.vector.dims = meta.vectorDims;
    }
    this.dirty = true;
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
    },
  ): Promise<MemorySearchResult[]> {
    if (this.config.sync.onSearch && this.dirty) {
      await this.sync().catch((err) => {
        console.warn(`memory sync failed (search): ${String(err)}`);
      });
    }
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }
    const minScore = opts?.minScore ?? this.config.query.minScore;
    const maxResults = opts?.maxResults ?? this.config.query.maxResults;
    const hybrid = this.config.hybrid;
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );

    const keywordResults = hybrid.enabled
      ? await this.searchKeyword(cleaned, candidates).catch(() => [])
      : [];

    const queryVec = await this.embedQueryWithTimeout(cleaned);
    const hasVector = queryVec.some((v) => v !== 0);
    const vectorResults = hasVector
      ? await this.searchVector(queryVec, candidates).catch(() => [])
      : [];

    if (!hybrid.enabled) {
      return vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    }

    const merged = this.mergeHybridResults({
      vector: vectorResults,
      keyword: keywordResults,
      vectorWeight: hybrid.vectorWeight,
      textWeight: hybrid.textWeight,
    });

    return merged.filter((entry) => entry.score >= minScore).slice(0, maxResults);
  }

  private async searchVector(
    queryVec: number[],
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string }>> {
    const results = await searchVector({
      db: this.db,
      vectorTable: VECTOR_TABLE,
      providerModel: this.provider.model,
      queryVec,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      ensureVectorReady: async (dimensions) => await this.ensureVectorReady(dimensions),
      sourceFilterVec: this.buildSourceFilter("c"),
      sourceFilterChunks: this.buildSourceFilter(),
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string });
  }

  private async searchKeyword(
    query: string,
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string; textScore: number }>> {
    if (!this.fts.enabled || !this.fts.available) {
      return [];
    }
    const sourceFilter = this.buildSourceFilter();
    const results = await searchKeyword({
      db: this.db,
      ftsTable: FTS_TABLE,
      providerModel: this.provider.model,
      query,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter,
      buildFtsQuery: (raw) => buildFtsQuery(raw),
      bm25RankToScore,
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string; textScore: number });
  }

  private mergeHybridResults(params: {
    vector: Array<MemorySearchResult & { id: string }>;
    keyword: Array<MemorySearchResult & { id: string; textScore: number }>;
    vectorWeight: number;
    textWeight: number;
  }): MemorySearchResult[] {
    const merged = mergeHybridResults({
      vector: params.vector.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: r.score,
      })),
      keyword: params.keyword.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        textScore: r.textScore,
      })),
      vectorWeight: params.vectorWeight,
      textWeight: params.textWeight,
    });
    return merged.map((entry) => entry as MemorySearchResult);
  }

  async sync(params?: { force?: boolean }): Promise<void> {
    if (this.syncing) {
      return this.syncing;
    }
    this.syncing = this.runSync(params).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async runSync(params?: { force?: boolean }): Promise<void> {
    const needsFullReindex = await this.checkNeedsFullReindex();

    // Sync global memory files
    await this.syncMemoryFiles({
      dir: this.globalDir,
      source: "global",
      needsFullReindex,
    });

    // Sync session memory files
    await this.syncMemoryFiles({
      dir: this.sessionDir,
      source: "session",
      needsFullReindex,
    });

    // Sync session transcript files (conversation logs)
    if (this.config.sync.indexSessions !== false) {
      await this.syncSessionTranscripts(needsFullReindex);
    }

    this.writeMeta();
    this.dirty = false;
  }

  private async syncSessionTranscripts(needsFullReindex: boolean): Promise<void> {
    await syncSessionFiles({
      db: this.db,
      needsFullReindex,
      vectorTable: VECTOR_TABLE,
      ftsTable: FTS_TABLE,
      ftsEnabled: this.fts.enabled,
      ftsAvailable: this.fts.available,
      model: this.provider.model,
      dirtyFiles: new Set(), // TODO: track dirty session files
      runWithConcurrency: (tasks, concurrency) => this.runWithConcurrency(tasks, concurrency),
      indexSessionFile: (entry) => this.indexSessionFile(entry),
      concurrency: EMBEDDING_INDEX_CONCURRENCY,
    });
  }

  private async indexSessionFile(entry: SessionFileEntry): Promise<void> {
    const chunks = chunkMarkdown(entry.content, this.config.chunking);

    // Delete existing chunks for this file
    try {
      this.db
        .prepare(
          `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
        )
        .run(entry.path, "sessions");
    } catch {}
    this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(entry.path, "sessions");
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db
          .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
          .run(entry.path, "sessions", this.provider.model);
      } catch {}
    }

    // Generate embeddings for chunks
    const texts = chunks.map((chunk) => chunk.text);
    const embeddings = texts.length > 0 ? await this.embedBatch(texts) : [];

    // Insert chunks
    const insertChunk = this.db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = this.fts.enabled && this.fts.available
      ? this.db.prepare(
          `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
      : null;

    this.db.exec("BEGIN");
    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = embeddings[i] ?? [];
        const id = randomUUID();
        const now = Date.now();

        insertChunk.run(
          id,
          entry.path,
          "sessions",
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          this.provider.model,
          chunk.text,
          JSON.stringify(embedding),
          now,
        );

        if (insertFts) {
          insertFts.run(
            chunk.text,
            id,
            entry.path,
            "sessions",
            this.provider.model,
            chunk.startLine,
            chunk.endLine,
          );
        }

        // Insert into vector table if available
        if (this.vector.available && embedding.length > 0) {
          await this.ensureVectorReady(embedding.length);
          try {
            this.db
              .prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
              .run(id, vectorToBlob(embedding));
          } catch {}
        }
      }

      // Update file record
      this.db
        .prepare(
          `INSERT OR REPLACE INTO files (path, source, hash, mtime, size)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(entry.path, "sessions", entry.hash, Math.floor(entry.mtimeMs), entry.size);

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private async syncMemoryFiles(params: {
    dir: string;
    source: MemorySource;
    needsFullReindex: boolean;
  }) {
    const files = await listMemoryFiles(params.dir);
    const fileEntries = await Promise.all(
      files.map(async (file) => buildFileEntry(file, params.dir)),
    );
    const activePaths = new Set(fileEntries.map((entry) => entry.path));

    const tasks = fileEntries.map((entry) => async () => {
      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(entry.path, params.source) as { hash: string } | undefined;
      if (!params.needsFullReindex && record?.hash === entry.hash) {
        return;
      }
      await this.indexFile(entry, { source: params.source });
    });
    await this.runWithConcurrency(tasks, EMBEDDING_INDEX_CONCURRENCY);

    // Remove stale entries
    const staleRows = this.db
      .prepare(`SELECT path FROM files WHERE source = ?`)
      .all(params.source) as Array<{ path: string }>;
    for (const stale of staleRows) {
      if (activePaths.has(stale.path)) {
        continue;
      }
      this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(stale.path, params.source);
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
          .run(stale.path, params.source);
      } catch {}
      this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(stale.path, params.source);
      if (this.fts.enabled && this.fts.available) {
        try {
          this.db
            .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
            .run(stale.path, params.source, this.provider.model);
        } catch {}
      }
    }
  }

  private async indexFile(entry: MemoryFileEntry, params: { source: MemorySource }): Promise<void> {
    const content = await fs.readFile(entry.absPath, "utf-8");
    const chunks = chunkMarkdown(content, this.config.chunking);

    // Delete existing chunks for this file
    try {
      this.db
        .prepare(
          `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
        )
        .run(entry.path, params.source);
    } catch {}
    this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(entry.path, params.source);
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db
          .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
          .run(entry.path, params.source, this.provider.model);
      } catch {}
    }

    // Generate embeddings for chunks
    const texts = chunks.map((chunk) => chunk.text);
    const embeddings = texts.length > 0 ? await this.embedBatch(texts) : [];

    // Insert chunks
    const insertChunk = this.db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = this.fts.enabled && this.fts.available
      ? this.db.prepare(
          `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
      : null;

    this.db.exec("BEGIN");
    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = embeddings[i] ?? [];
        const id = randomUUID();
        const now = Date.now();

        insertChunk.run(
          id,
          entry.path,
          params.source,
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          this.provider.model,
          chunk.text,
          JSON.stringify(embedding),
          now,
        );

        if (insertFts) {
          insertFts.run(
            chunk.text,
            id,
            entry.path,
            params.source,
            this.provider.model,
            chunk.startLine,
            chunk.endLine,
          );
        }

        // Insert into vector table if available
        if (this.vector.available && embedding.length > 0) {
          await this.ensureVectorReady(embedding.length);
          try {
            this.db
              .prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
              .run(id, vectorToBlob(embedding));
          } catch {}
        }
      }

      // Update file record
      this.db
        .prepare(
          `INSERT OR REPLACE INTO files (path, source, hash, mtime, size)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(entry.path, params.source, entry.hash, Math.floor(entry.mtimeMs), entry.size);

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private async embedQueryWithTimeout(text: string): Promise<number[]> {
    return this.withTimeout(
      this.provider.embedQuery(text),
      EMBEDDING_QUERY_TIMEOUT_MS,
      `embedding query timed out`,
    );
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    // Check cache first
    const results: number[][] = new Array(texts.length);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    if (this.cache.enabled) {
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        const hash = hashText(text);
        const cached = this.getCachedEmbedding(hash);
        if (cached) {
          results[i] = cached;
        } else {
          uncachedIndices.push(i);
          uncachedTexts.push(text);
        }
      }
    } else {
      for (let i = 0; i < texts.length; i++) {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]);
      }
    }

    if (uncachedTexts.length > 0) {
      const embeddings = await this.provider.embedBatch(uncachedTexts);
      for (let j = 0; j < uncachedIndices.length; j++) {
        const i = uncachedIndices[j];
        const embedding = embeddings[j] ?? [];
        results[i] = embedding;

        if (this.cache.enabled && embedding.length > 0) {
          const hash = hashText(uncachedTexts[j]);
          this.setCachedEmbedding(hash, embedding);
        }
      }
    }

    return results;
  }

  private getCachedEmbedding(hash: string): number[] | null {
    if (!this.cache.enabled) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT embedding FROM ${EMBEDDING_CACHE_TABLE}
         WHERE provider = ? AND model = ? AND provider_key = ? AND hash = ?`,
      )
      .get(this.provider.id, this.provider.model, this.providerKey, hash) as
      | { embedding: string }
      | undefined;
    if (!row?.embedding) {
      return null;
    }
    try {
      return JSON.parse(row.embedding);
    } catch {
      return null;
    }
  }

  private setCachedEmbedding(hash: string, embedding: number[]): void {
    if (!this.cache.enabled) {
      return;
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${EMBEDDING_CACHE_TABLE}
         (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.provider.id,
        this.provider.model,
        this.providerKey,
        hash,
        JSON.stringify(embedding),
        embedding.length,
        Date.now(),
      );
  }

  private async checkNeedsFullReindex(): Promise<boolean> {
    const meta = this.readMeta();
    if (!meta) {
      return true;
    }
    if (meta.model !== this.provider.model) {
      return true;
    }
    if (meta.provider !== this.provider.id) {
      return true;
    }
    if (meta.chunkTokens !== this.config.chunking.tokens) {
      return true;
    }
    if (meta.chunkOverlap !== this.config.chunking.overlap) {
      return true;
    }
    return false;
  }

  private readMeta(): MemoryIndexMeta | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY) as
      | { value: string }
      | undefined;
    if (!row?.value) {
      return null;
    }
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  private writeMeta(): void {
    const meta: MemoryIndexMeta = {
      model: this.provider.model,
      provider: this.provider.id,
      providerKey: this.providerKey,
      chunkTokens: this.config.chunking.tokens,
      chunkOverlap: this.config.chunking.overlap,
      vectorDims: this.vector.dims,
    };
    this.db
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
      .run(META_KEY, JSON.stringify(meta));
  }

  private computeProviderKey(): string {
    if (this.openAi) {
      return `${this.openAi.baseUrl}:${this.openAi.model}`;
    }
    if (this.gemini) {
      return `${this.gemini.baseUrl}:${this.gemini.model}`;
    }
    return `local:${this.provider.model}`;
  }

  private buildSourceFilter(alias?: string): { sql: string; params: MemorySource[] } {
    const sources = Array.from(this.sources);
    if (sources.length === 0) {
      return { sql: "", params: [] };
    }
    const column = alias ? `${alias}.source` : "source";
    const placeholders = sources.map(() => "?").join(", ");
    return { sql: ` AND ${column} IN (${placeholders})`, params: sources };
  }

  private openDatabase(): DatabaseSync {
    const dbPath = this.config.store.path;
    const dir = path.dirname(dbPath);
    ensureDir(dir);
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(dbPath, { allowExtension: this.config.store.vector.enabled });
  }

  private ensureSchema() {
    const result = ensureMemoryIndexSchema({
      db: this.db,
      embeddingCacheTable: EMBEDDING_CACHE_TABLE,
      ftsTable: FTS_TABLE,
      ftsEnabled: this.fts.enabled,
    });
    this.fts.available = result.ftsAvailable;
    if (result.ftsError) {
      this.fts.loadError = result.ftsError;
      console.warn(`fts unavailable: ${result.ftsError}`);
    }
  }

  private async ensureVectorReady(dimensions?: number): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    if (!this.vectorReady) {
      this.vectorReady = this.withTimeout(
        this.loadVectorExtension(),
        VECTOR_LOAD_TIMEOUT_MS,
        `sqlite-vec load timed out`,
      );
    }
    let ready = false;
    try {
      ready = await this.vectorReady;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.vector.available = false;
      this.vector.loadError = message;
      this.vectorReady = null;
      console.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
    if (ready && typeof dimensions === "number" && dimensions > 0) {
      this.ensureVectorTable(dimensions);
    }
    return ready;
  }

  private async loadVectorExtension(): Promise<boolean> {
    if (this.vector.available !== null) {
      return this.vector.available;
    }
    if (!this.vector.enabled) {
      this.vector.available = false;
      return false;
    }
    try {
      const loaded = await loadSqliteVecExtension({
        db: this.db,
        extensionPath: this.vector.extensionPath,
      });
      if (!loaded.ok) {
        throw new Error(loaded.error ?? "unknown sqlite-vec load error");
      }
      this.vector.extensionPath = loaded.extensionPath;
      this.vector.available = true;
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.vector.available = false;
      this.vector.loadError = message;
      console.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
  }

  private ensureVectorTable(dimensions: number): void {
    if (this.vector.dims === dimensions) {
      return;
    }
    if (this.vector.dims && this.vector.dims !== dimensions) {
      this.dropVectorTable();
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${dimensions}]\n` +
        `)`,
    );
    this.vector.dims = dimensions;
  }

  private dropVectorTable(): void {
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
    } catch {}
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }

  private async runWithConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    concurrency: number,
  ): Promise<T[]> {
    const results: T[] = [];
    const executing: Promise<void>[] = [];

    for (const task of tasks) {
      const p = task().then((result) => {
        results.push(result);
      });
      executing.push(p);

      if (executing.length >= concurrency) {
        await Promise.race(executing);
        executing.splice(
          executing.findIndex((e) => e === p),
          1,
        );
      }
    }

    await Promise.all(executing);
    return results;
  }

  status(): {
    files: number;
    chunks: number;
    dirty: boolean;
    provider: string;
    model: string;
    fts: { enabled: boolean; available: boolean };
    vector: { enabled: boolean; available: boolean | null };
  } {
    const files = this.db.prepare(`SELECT COUNT(*) as c FROM files`).get() as { c: number };
    const chunks = this.db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number };
    return {
      files: files?.c ?? 0,
      chunks: chunks?.c ?? 0,
      dirty: this.dirty,
      provider: this.provider.id,
      model: this.provider.model,
      fts: { enabled: this.fts.enabled, available: this.fts.available },
      vector: { enabled: this.vector.enabled, available: this.vector.available },
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }
}
