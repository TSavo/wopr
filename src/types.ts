// Protocol version
export const PROTOCOL_VERSION = 2;
export const MIN_PROTOCOL_VERSION = 1;

// Session types
export interface Session {
  name: string;
  context?: string;
  created: number;
  provider?: {
    name: string;              // "anthropic" | "openai" | etc.
    model?: string;            // optional model override
    fallback?: string[];       // fallback provider chain
    options?: Record<string, unknown>;  // provider-specific options
  };
}

// Conversation log types
export type ConversationEntryType = "context" | "message" | "response" | "middleware";

export interface ChannelRef {
  id: string;              // Channel identifier (e.g., discord channel ID)
  type: string;            // Channel type (e.g., "discord", "p2p")
  name?: string;           // Optional human-friendly label
}

export interface ConversationEntry {
  ts: number;              // Timestamp
  from: string;            // Username or "WOPR" or "system"
  content: string;         // Message content
  type: ConversationEntryType;
  channel?: ChannelRef;    // Optional channel metadata for traceability
}

// Cron types
export interface CronJob {
  name: string;
  schedule: string;
  session: string;
  message: string;
  once?: boolean;
  runAt?: number;
}

// Identity types
export interface Identity {
  publicKey: string;      // Ed25519 for signing
  privateKey: string;
  encryptPub: string;     // X25519 for encryption
  encryptPriv: string;
  created: number;
  rotatedFrom?: string;   // Previous publicKey if rotated
  rotatedAt?: number;
}

// Key rotation types
export interface KeyRotation {
  v: 1;
  type: "key-rotation";
  oldSignPub: string;
  newSignPub: string;
  newEncryptPub: string;
  reason: "scheduled" | "compromise" | "upgrade";
  effectiveAt: number;
  gracePeriodMs: number;
  sig: string;            // Signed with OLD key
}

export interface KeyHistory {
  publicKey: string;
  encryptPub: string;
  validFrom: number;
  validUntil?: number;
  rotationReason?: string;
}

// Trust types
export interface AccessGrant {
  id: string;
  peerKey: string;        // Ed25519 pubkey (current)
  peerEncryptPub?: string; // X25519 pubkey for encryption
  peerName?: string;
  sessions: string[];
  caps: string[];
  created: number;
  revoked?: boolean;
  keyHistory?: KeyHistory[];  // Track key rotations
}

export interface Peer {
  id: string;
  publicKey: string;      // Ed25519 for verifying signatures (current)
  encryptPub?: string;    // X25519 for encryption (learned during claim)
  name?: string;
  sessions: string[];
  caps: string[];
  added: number;
  keyHistory?: KeyHistory[];  // Track key rotations
}

export interface InviteToken {
  v: 1;
  iss: string;        // Issuer's public key
  sub: string;        // Subject - who this token is FOR (their public key)
  ses: string[];      // Sessions this grants access to
  cap: string[];      // Capabilities (e.g., "inject")
  exp: number;        // Expiration timestamp
  nonce: string;
  sig: string;
}

// P2P message types
export type P2PMessageType =
  | "hello"
  | "hello-ack"
  | "inject"
  | "claim"
  | "ack"
  | "reject"
  | "key-rotation";

export interface P2PMessage {
  v: number;              // Protocol version
  type: P2PMessageType;
  from: string;
  encryptPub?: string;    // X25519 pubkey for encryption
  ephemeralPub?: string;  // Ephemeral X25519 for PFS
  session?: string;
  payload?: string;       // Message content (for inject) - encrypted
  token?: string;         // Encoded token (for claim)
  reason?: string;        // Rejection reason
  versions?: number[];    // Supported versions (for hello)
  version?: number;       // Negotiated version (for hello-ack)
  keyRotation?: Omit<KeyRotation, "type">;  // Key rotation data
  nonce: string;
  ts: number;
  sig: string;
}

// Ephemeral key pair for forward secrecy
export interface EphemeralKeyPair {
  publicKey: string;      // X25519 public
  privateKey: string;     // X25519 private
  created: number;
  expiresAt: number;
}

// Rate limiting types
export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  blockDurationMs: number;
}

export interface RateLimitState {
  requests: number[];     // Timestamps of requests
  blockedUntil?: number;
}

export interface RateLimits {
  connections: RateLimitConfig;
  claims: RateLimitConfig;
  injects: RateLimitConfig;
  invalidMessages: RateLimitConfig;
}

// Replay protection
export interface ReplayState {
  seenNonces: Map<string, number>;  // nonce -> timestamp
  maxAgeMs: number;
}

// Registry types
export interface SkillPointer {
  name: string;
  description: string;
  source: string;
  version?: string;
}

export interface Registry {
  name: string;
  url: string;
}

// Discovery types
export interface Profile {
  id: string;             // Short key
  publicKey: string;      // Full pubkey for identity
  encryptPub: string;     // X25519 for encryption
  content: any;           // AI-generated, freeform - whatever it wants to say
  topics: string[];       // Topics currently active in
  updated: number;
  sig: string;            // Signed by identity key
}

export type DiscoveryMessageType =
  | "announce"            // Broadcast presence + profile to topic
  | "withdraw"            // Leaving topic
  | "profile-request"     // Ask for someone's full profile
  | "profile-response"    // Send profile
  | "connect-request"     // Ask to establish mutual trust
  | "connect-response";   // Accept/reject connection

export interface DiscoveryMessage {
  v: 1;
  type: DiscoveryMessageType;
  from: string;           // Sender's pubkey
  encryptPub?: string;    // For encryption
  topic?: string;         // Topic this relates to
  profile?: Profile;      // For announce/profile-response
  reason?: string;        // For rejection or context
  accepted?: boolean;     // For connect-response
  sessions?: string[];    // Sessions offered (for connect-response accept)
  nonce: string;
  ts: number;
  sig: string;
}

// Topic state
export interface TopicState {
  topic: string;
  joined: number;
  peers: Map<string, Profile>;  // pubkey -> profile
}

// ============================================================================
// Plugin System
// ============================================================================

export interface WOPRPlugin {
  name: string;
  version: string;
  description?: string;

  // Runtime hooks (daemon)
  init?(ctx: WOPRPluginContext): Promise<void>;
  shutdown?(): Promise<void>;

  // CLI extensions
  commands?: PluginCommand[];
}

export interface PluginCommand {
  name: string;
  description: string;
  usage?: string;
  handler: (ctx: WOPRPluginContext, args: string[]) => Promise<void>;
}

// Streaming message from Claude
export interface StreamMessage {
  type: "text" | "tool_use" | "complete" | "error";
  content: string;
  toolName?: string;
}

export type StreamCallback = (msg: StreamMessage) => void;

// Context provider interface - plugins implement this to provide conversation context
export interface ContextProvider {
  // Get conversation context for a session (e.g., recent Discord messages)
  getContext(session: string): Promise<string>;
}

export interface MiddlewareInput {
  session: string;
  from: string;
  message: string;
  channel?: ChannelRef;
}

export interface MiddlewareOutput {
  session: string;
  from: string;
  response: string;
  channel?: ChannelRef;
}

export interface MessageMiddleware {
  name: string;
  onIncoming?(input: MiddlewareInput): Promise<string | null>;
  onOutgoing?(output: MiddlewareOutput): Promise<string | null>;
}

export interface ChannelAdapter {
  channel: ChannelRef;
  session: string;
  getContext(): Promise<string>;
  send(message: string): Promise<void>;
}

// Web UI Extension - plugins register navigation links to extend the UI
export interface WebUiExtension {
  id: string;           // Unique identifier (scoped to plugin)
  title: string;        // Display name in UI
  url: string;          // URL to open (can be relative or absolute)
  description?: string; // Optional tooltip/description
  category?: string;    // Optional grouping (e.g., "core", "integrations", "tools")
}

export interface WOPRPluginContext {
  // Inject into local session, get response (with optional streaming)
  inject(session: string, message: string, onStream?: StreamCallback): Promise<string>;

  // Inject to peer's session, get response
  injectPeer(peer: string, session: string, message: string): Promise<string>;

  // Identity (read-only)
  getIdentity(): { publicKey: string; shortId: string; encryptPub: string };

  // Sessions
  getSessions(): string[];

  // Peers
  getPeers(): Peer[];

  // Events - when sessions receive injections
  on(event: "injection", handler: InjectionHandler): void;
  on(event: "stream", handler: StreamHandler): void;
  off(event: "injection", handler: InjectionHandler): void;
  off(event: "stream", handler: StreamHandler): void;

  // Context providers - plugins register to provide conversation context
  registerContextProvider(session: string, provider: ContextProvider): void;
  unregisterContextProvider(session: string): void;

  // Channels - plugins register message channels (e.g., Discord, P2P peers)
  registerChannel(adapter: ChannelAdapter): void;
  unregisterChannel(channel: ChannelRef): void;
  getChannel(channel: ChannelRef): ChannelAdapter | undefined;
  getChannels(): ChannelAdapter[];
  getChannelsForSession(session: string): ChannelAdapter[];

  // Middlewares - plugins register message middleware for channels/sessions
  registerMiddleware(middleware: MessageMiddleware): void;
  unregisterMiddleware(name: string): void;
  getMiddlewares(): MessageMiddleware[];

  // Web UI extensions - plugins register navigation links
  registerWebUiExtension(extension: WebUiExtension): void;
  unregisterWebUiExtension(id: string): void;
  getWebUiExtensions(): WebUiExtension[];

  // Plugin's own config
  getConfig<T = any>(): T;
  saveConfig<T = any>(config: T): Promise<void>;

  // Main WOPR config (read-only access)
  getMainConfig(key?: string): any;

  // Logging
  log: PluginLogger;

  // Access to plugin directory
  getPluginDir(): string;
}

export type InjectionHandler = (
  session: string,
  from: string, // peer pubkey or "local"
  message: string,
  response: string
) => void;

// Streaming event - emitted as chunks arrive
export interface SessionStreamEvent {
  session: string;
  from: string; // "cli" | "cron" | "p2p" | peer pubkey
  message: StreamMessage;
}

export type StreamHandler = (event: SessionStreamEvent) => void;

export interface PluginLogger {
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  debug(message: string, ...args: any[]): void;
}

export interface InstalledPlugin {
  name: string;
  version: string;
  description?: string;
  source: "npm" | "github" | "local";
  path: string;
  enabled: boolean;
  installedAt: number;
}

export interface PluginRegistryEntry {
  name: string;
  url: string;
  enabled: boolean;
  lastSync: number;
}

// Exit codes
export const EXIT_OK = 0;
export const EXIT_OFFLINE = 1;
export const EXIT_REJECTED = 2;
export const EXIT_INVALID = 3;
export const EXIT_RATE_LIMITED = 4;
export const EXIT_VERSION_MISMATCH = 5;
