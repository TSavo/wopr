/**
 * WOPR Voice Plugin Types
 *
 * Interfaces for STT (Speech-to-Text) and TTS (Text-to-Speech) plugins.
 * Based on clawdbot PR 1154 plugin architecture.
 */

// =============================================================================
// Audio Formats
// =============================================================================

export type AudioFormat =
  | "pcm_s16le"      // 16-bit signed little-endian PCM
  | "pcm_f32le"      // 32-bit float little-endian PCM
  | "opus"           // Opus codec (Discord, Telegram)
  | "ogg_opus"       // Ogg container with Opus
  | "mp3"            // MP3
  | "wav"            // WAV container
  | "webm_opus"      // WebM container with Opus
  | "mulaw"          // G.711 μ-law (Twilio)
  | "alaw";          // G.711 A-law

export interface AudioConfig {
  format: AudioFormat;
  sampleRate: number;    // e.g., 16000, 24000, 48000
  channels: number;      // 1 = mono, 2 = stereo
  bitDepth?: number;     // For PCM: 16, 32
}

// =============================================================================
// Plugin Metadata & Dependency System
// =============================================================================

/**
 * Installation method for a dependency.
 * Based on clawdbot PR 1154 auto-install pattern.
 */
export type InstallMethod =
  | { kind: "brew"; formula: string; bins?: string[]; label?: string }
  | { kind: "apt"; package: string; bins?: string[]; label?: string }
  | { kind: "pip"; package: string; bins?: string[]; label?: string }
  | { kind: "npm"; package: string; bins?: string[]; label?: string }
  | { kind: "docker"; image: string; tag?: string; label?: string }
  | { kind: "script"; url: string; label?: string }
  | { kind: "manual"; instructions: string; label?: string };

/**
 * Dependency requirements for a voice plugin.
 * Specifies what binaries, env vars, or services are needed.
 */
export interface VoicePluginRequirements {
  /** Required binary executables (checked via `which`) */
  bins?: string[];
  /** Required environment variables */
  env?: string[];
  /** Required docker images */
  docker?: string[];
  /** Required config keys (dot-notation paths) */
  config?: string[];
}

/**
 * Metadata for a voice plugin with auto-install support.
 *
 * Example usage:
 * ```typescript
 * const metadata: VoicePluginMetadata = {
 *   name: "whisper-local",
 *   version: "1.0.0",
 *   type: "stt",
 *   description: "Local Whisper STT using faster-whisper",
 *   capabilities: ["batch", "streaming"],
 *   local: true,
 *   docker: true,
 *   requires: {
 *     docker: ["ghcr.io/wopr/faster-whisper:latest"],
 *   },
 *   install: [
 *     { kind: "docker", image: "ghcr.io/wopr/faster-whisper", tag: "latest", label: "Pull faster-whisper image" },
 *   ],
 * };
 * ```
 */
export interface VoicePluginMetadata {
  name: string;                    // "whisper-local", "elevenlabs"
  version: string;                 // "1.0.0"
  type: "stt" | "tts";
  description: string;
  capabilities: string[];          // ["streaming", "batch", "voice-selection"]
  local: boolean;                  // true = no API calls, runs locally
  docker?: boolean;                // true = runs in docker container

  /** What this plugin requires to run */
  requires?: VoicePluginRequirements;

  /** How to install missing dependencies (ordered by preference) */
  install?: InstallMethod[];

  /** Primary environment variable for API key (if cloud-based) */
  primaryEnv?: string;

  /** Emoji for UI display */
  emoji?: string;

  /** Homepage/documentation URL */
  homepage?: string;
}

// =============================================================================
// STT (Speech-to-Text) Provider Interface
// =============================================================================

export interface STTTranscriptChunk {
  text: string;
  isFinal: boolean;
  confidence?: number;
  timestamp?: number;              // ms from start of audio
}

export interface STTOptions {
  language?: string;               // "en", "es", "auto"
  format?: AudioFormat;
  sampleRate?: number;
  vadEnabled?: boolean;            // Voice Activity Detection
  vadSilenceMs?: number;           // Silence duration to end utterance
  wordTimestamps?: boolean;
}

export interface STTSession {
  /** Send audio chunk for transcription */
  sendAudio(audio: Buffer): void;

  /** Signal end of audio stream */
  endAudio(): void;

  /** Get partial transcripts as they arrive (streaming) */
  onPartial?(callback: (chunk: STTTranscriptChunk) => void): void;

  /** Wait for final transcript */
  waitForTranscript(timeoutMs?: number): Promise<string>;

  /** Close session and cleanup */
  close(): Promise<void>;
}

export interface STTProvider {
  readonly metadata: VoicePluginMetadata;

  /** Validate configuration (throws on invalid) */
  validateConfig(): void;

  /** Create a transcription session (for streaming) */
  createSession(options?: STTOptions): Promise<STTSession>;

  /** Batch transcribe entire audio buffer (convenience method) */
  transcribe(audio: Buffer, options?: STTOptions): Promise<string>;

  /** Health check (for cloud providers) */
  healthCheck?(): Promise<boolean>;

  /** Shutdown and cleanup */
  shutdown?(): Promise<void>;
}

// =============================================================================
// TTS (Text-to-Speech) Provider Interface
// =============================================================================

export interface Voice {
  id: string;                      // "en_US-lessac-medium", "alloy"
  name: string;                    // "Lessac (US English)"
  language?: string;               // "en-US"
  gender?: "male" | "female" | "neutral";
  description?: string;
}

export interface TTSOptions {
  voice?: string;                  // Voice ID
  speed?: number;                  // 0.5 - 2.0
  pitch?: number;                  // -1.0 to 1.0
  format?: AudioFormat;
  sampleRate?: number;
  instructions?: string;           // Voice style instructions (OpenAI gpt-4o-mini-tts)
}

export interface TTSSynthesisResult {
  audio: Buffer;
  format: AudioFormat;
  sampleRate: number;
  durationMs: number;
}

export interface TTSProvider {
  readonly metadata: VoicePluginMetadata;

  /** Available voices for this provider */
  readonly voices: Voice[];

  /** Validate configuration (throws on invalid) */
  validateConfig(): void;

  /** Synthesize text to audio */
  synthesize(text: string, options?: TTSOptions): Promise<TTSSynthesisResult>;

  /** Stream synthesis (for long text) */
  streamSynthesize?(text: string, options?: TTSOptions): AsyncGenerator<Buffer>;

  /** Batch synthesize multiple texts */
  synthesizeBatch?(texts: string[], options?: TTSOptions): Promise<TTSSynthesisResult[]>;

  /** Health check (for cloud providers) */
  healthCheck?(): Promise<boolean>;

  /** Shutdown and cleanup */
  shutdown?(): Promise<void>;
}

// =============================================================================
// Voice Registry (managed by core)
// =============================================================================

export interface VoiceRegistry {
  /** Register an STT provider */
  registerSTT(provider: STTProvider): void;

  /** Register a TTS provider */
  registerTTS(provider: TTSProvider): void;

  /** Get the active STT provider */
  getSTT(): STTProvider | null;

  /** Get the active TTS provider */
  getTTS(): TTSProvider | null;

  /** List all registered STT providers */
  listSTT(): STTProvider[];

  /** List all registered TTS providers */
  listTTS(): TTSProvider[];

  /** Set the active STT provider by name */
  setActiveSTT(name: string): boolean;

  /** Set the active TTS provider by name */
  setActiveTTS(name: string): boolean;
}

// =============================================================================
// Plugin Context Extensions
// =============================================================================

/** Extension to WOPRPluginContext for voice plugins */
export interface VoicePluginContext {
  /** Register this plugin as an STT provider */
  registerSTTProvider(provider: STTProvider): void;

  /** Register this plugin as a TTS provider */
  registerTTSProvider(provider: TTSProvider): void;
}

/** Extension to WOPRPluginContext for channels using voice */
export interface VoiceConsumerContext {
  /** Get the active STT provider (null if none registered) */
  getSTT(): STTProvider | null;

  /** Get the active TTS provider (null if none registered) */
  getTTS(): TTSProvider | null;

  /** Check if voice is available */
  hasVoice(): { stt: boolean; tts: boolean };
}
