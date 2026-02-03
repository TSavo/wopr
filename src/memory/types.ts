// Type definitions for WOPR memory system

export type MemorySource = "global" | "session" | "sessions";

export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: MemorySource;
};

export type MemoryConfig = {
  provider: "openai" | "gemini" | "local" | "auto";
  model: string;
  fallback: "openai" | "gemini" | "local" | "none";
  chunking: {
    tokens: number;
    overlap: number;
  };
  hybrid: {
    enabled: boolean;
    vectorWeight: number;
    textWeight: number;
    candidateMultiplier: number;
  };
  query: {
    maxResults: number;
    minScore: number;
  };
  store: {
    path: string;
    vector: {
      enabled: boolean;
      extensionPath?: string;
    };
  };
  cache: {
    enabled: boolean;
    maxEntries?: number;
  };
  sync: {
    onSearch: boolean;
    watch: boolean;
    watchDebounceMs: number;
    indexSessions: boolean;
  };
  remote?: {
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  };
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
};

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  provider: "auto",
  model: "text-embedding-3-small",
  fallback: "gemini",
  chunking: {
    tokens: 400,
    overlap: 80,
  },
  hybrid: {
    enabled: true,
    vectorWeight: 0.7,
    textWeight: 0.3,
    candidateMultiplier: 4,
  },
  query: {
    maxResults: 10,
    minScore: 0.35,
  },
  store: {
    path: "", // Will be set dynamically
    vector: {
      enabled: true,
    },
  },
  cache: {
    enabled: true,
    maxEntries: 10000,
  },
  sync: {
    onSearch: true,
    watch: true,
    watchDebounceMs: 1500,
    indexSessions: true,
  },
};
