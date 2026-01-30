/**
 * Onboard wizard types
 */

export interface OnboardConfig {
  workspace?: string;
  provider?: {
    primary?: string;
    kimi?: { apiKey?: string; baseUrl?: string };
    anthropic?: { apiKey?: string };
    openai?: { apiKey?: string };
  };
  gateway?: {
    port?: number;
    bind?: "loopback" | "lan" | "all";
    auth?: {
      mode?: "token" | "none";
      token?: string;
    };
  };
  channels?: string[];
  skills?: string[];
  plugins?: string[];
  voicePlugins?: string[];  // Installed voice plugins (STT, TTS, channels)
  wizard?: {
    lastRunAt?: string;
    lastRunVersion?: string;
    lastRunCommand?: string;
    lastRunMode?: string;
  };
}

export interface OnboardOptions {
  flow?: "quickstart" | "advanced";
  workspace?: string;
  reset?: boolean;
  skipChannels?: boolean;
  skipSkills?: boolean;
  skipPlugins?: boolean;
  skipDaemon?: boolean;
  skipUi?: boolean;
  acceptRisk?: boolean;
  mode?: "local" | "remote";
}

export interface OnboardRuntime {
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => void;
}

export interface OnboardContext {
  opts: OnboardOptions;
  runtime: OnboardRuntime;
  baseConfig: OnboardConfig;
  nextConfig: OnboardConfig;
}

export type OnboardStep = (
  ctx: OnboardContext
) => Promise<Partial<OnboardConfig> | void>;

// Available model providers (all via plugins)
export const AVAILABLE_PROVIDERS = [
  { id: "kimi", name: "Kimi (Moonshot AI)", models: ["kimi-k2", "kimi-k1.5"], npm: "wopr-plugin-provider-kimi" },
  { id: "anthropic", name: "Anthropic (Claude)", models: ["claude-sonnet-4", "claude-opus-4"], npm: "wopr-plugin-provider-anthropic" },
  { id: "openai", name: "OpenAI", models: ["gpt-4o", "gpt-4o-mini"], npm: "wopr-plugin-provider-openai" },
  { id: "opencode", name: "OpenCode (Windsurf)", models: ["claude-3.5-sonnet", "gpt-4o"], npm: "wopr-plugin-provider-opencode" },
] as const;

// Available channel plugins
export const AVAILABLE_CHANNELS = [
  { id: "discord", name: "Discord", description: "Discord bot integration", npm: "wopr-plugin-discord" },
  { id: "slack", name: "Slack", description: "Slack workspace integration", npm: "wopr-plugin-slack" },
  { id: "whatsapp", name: "WhatsApp", description: "WhatsApp Web via Baileys", npm: "wopr-plugin-whatsapp" },
  { id: "telegram", name: "Telegram", description: "Telegram Bot via Grammy", npm: "wopr-plugin-telegram" },
  { id: "signal", name: "Signal", description: "Signal messaging via signal-cli", npm: "wopr-plugin-signal" },
  { id: "msteams", name: "Microsoft Teams", description: "MS Teams via Azure Bot Framework", npm: "wopr-plugin-msteams" },
  { id: "imessage", name: "iMessage (macOS)", description: "iMessage/SMS via imsg CLI (macOS only)", npm: "wopr-plugin-imessage" },
  { id: "p2p", name: "P2P Network", description: "Peer-to-peer messaging via Hyperswarm", npm: "wopr-plugin-p2p" },
] as const;

// Available skills (from our skills system)
export const AVAILABLE_SKILLS = [
  { id: "web-search", name: "Web Search", description: "Search the web using Brave API" },
  { id: "file-ops", name: "File Operations", description: "Read/write files in workspace" },
  { id: "shell", name: "Shell Commands", description: "Execute shell commands" },
  { id: "memory", name: "Memory", description: "Persistent memory and recall" },
] as const;

// Available plugins
export const AVAILABLE_PLUGINS = [
  { id: "webui", name: "Web UI", description: "Web interface (included)", npm: null },
  { id: "discord", name: "Discord Plugin", description: "Discord bot integration", npm: "wopr-plugin-discord" },
] as const;

// Available voice plugins (STT and TTS)
export const AVAILABLE_VOICE_PLUGINS = {
  stt: [
    { id: "whisper-local", name: "Whisper (Local)", description: "Local STT via whisper.cpp (no API key)", npm: "wopr-plugin-voice-whisper-local", local: true },
    { id: "deepgram", name: "Deepgram", description: "Cloud STT with streaming (DEEPGRAM_API_KEY)", npm: "wopr-plugin-voice-deepgram-stt", local: false, env: "DEEPGRAM_API_KEY" },
  ],
  tts: [
    { id: "piper-local", name: "Piper (Local)", description: "Local TTS via Docker (no API key)", npm: "wopr-plugin-voice-piper-tts", local: true },
    { id: "openai-tts", name: "OpenAI TTS", description: "Cloud TTS via OpenAI (OPENAI_API_KEY)", npm: "wopr-plugin-voice-openai-tts", local: false, env: "OPENAI_API_KEY" },
    { id: "elevenlabs", name: "ElevenLabs", description: "Cloud TTS with voice cloning (ELEVENLABS_API_KEY)", npm: "wopr-plugin-voice-elevenlabs-tts", local: false, env: "ELEVENLABS_API_KEY" },
  ],
  channels: [
    { id: "discord-voice", name: "Discord Voice", description: "Discord voice channel integration", npm: "wopr-plugin-channel-discord-voice" },
  ],
  cli: [
    { id: "voice-cli", name: "Voice CLI", description: "CLI commands (wopr voice transcribe/synthesize)", npm: "wopr-plugin-voice-cli" },
  ],
} as const;
