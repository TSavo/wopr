// Protocol version
export const PROTOCOL_VERSION = 2;
export const MIN_PROTOCOL_VERSION = 1;

// Re-export provider types for plugins
export type { ModelProvider } from "./types/provider.js";

// Re-export security types for plugins and external use
export type {
  TrustLevel,
  Capability,
  InjectionSource,
  InjectionSourceType,
  SecurityPolicy,
  SecurityConfig,
  SandboxConfig,
  SecurityEvent,
} from "./security/types.js";

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

export interface CronHistoryEntry {
  name: string;
  session: string;
  timestamp: number;
  success: boolean;
  durationMs: number;
  error?: string;
  message: string; // Full message
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

// Agent persona identity (from IDENTITY.md)
export interface AgentIdentity {
  name?: string;          // Agent name (e.g., "WOPR")
  creature?: string;      // What the agent is (e.g., "AI Assistant")
  vibe?: string;          // Personality description
  emoji?: string;         // Preferred emoji for reactions
}

// User profile (from USER.md)
export interface UserProfile {
  name?: string;
  preferredAddress?: string;
  pronouns?: string;
  timezone?: string;
  notes?: string;
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
// A2A (Agent-to-Agent) Tool Types
// ============================================================================

/**
 * Result from an A2A tool handler
 */
export interface A2AToolResult {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/**
 * Definition of an A2A tool that plugins can register
 */
export interface A2AToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema format
  handler: (args: Record<string, unknown>) => Promise<A2AToolResult>;
}

/**
 * Configuration for registering an A2A server (collection of tools)
 */
export interface A2AServerConfig {
  name: string;
  version?: string;
  tools: A2AToolDefinition[];
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
/**
 * Composable context provider - plugins register these to contribute context
 */
export interface ContextProvider {
  name: string;
  priority: number;
  enabled?: boolean | ((session: string, message: MessageInfo) => boolean);
  getContext(session: string, message: MessageInfo): Promise<ContextPart | null>;
}

export interface MessageInfo {
  content: string;
  from: string;
  channel?: ChannelRef;
  timestamp: number;
}

export interface ContextPart {
  content: string;
  role?: "system" | "context" | "warning" | "user";
  metadata?: {
    source: string;
    priority: number;
    trustLevel?: "trusted" | "untrusted" | "verified";
    [key: string]: any;
  };
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

// UI Component Extension - plugins export SolidJS components that render inline
export interface UiComponentExtension {
  id: string;           // Unique identifier (scoped to plugin)
  title: string;        // Display name
  // URL to the ES module that exports the component as default
  // The module should export: export default function MyComponent(props) { ... }
  moduleUrl: string;
  slot: 'sidebar' | 'settings' | 'statusbar' | 'chat-header' | 'chat-footer';
  description?: string;
}

// Props passed to plugin UI components
export interface PluginUiComponentProps {
  // API client for making requests to WOPR daemon
  api: {
    getSessions: () => Promise<{ sessions: any[] }>;
    inject: (session: string, message: string) => Promise<any>;
    getConfig: () => Promise<any>;
    setConfigValue: (key: string, value: any) => Promise<void>;
  };
  // Current session context (if in chat view)
  currentSession?: string;
  // Plugin's own config
  pluginConfig: any;
  // Save plugin config
  saveConfig: (config: any) => Promise<void>;
}

export interface MultimodalMessage {
  text: string;
  images?: string[];  // URLs of images
}

// Config schema for provider/plugin configuration UI
export interface ConfigField {
  name: string;
  type: "text" | "password" | "select" | "checkbox" | "number";
  label: string;
  placeholder?: string;
  required?: boolean;
  default?: any;
  options?: { value: string; label: string }[]; // For select type
  description?: string;
}

export interface ConfigSchema {
  title: string;
  description?: string;
  fields: ConfigField[];
}

export interface PluginInjectOptions {
  silent?: boolean;
  onStream?: StreamCallback;
  from?: string;
  channel?: ChannelRef;
  images?: string[];
}

// ============================================================================
// Event Bus Types
// ============================================================================

/**
 * Base event interface - all events extend this
 */
export interface WOPREvent {
  type: string;
  payload: any;
  timestamp: number;
  source?: string;
}

// Session lifecycle events
export interface SessionCreateEvent {
  session: string;
  config?: any;
}

export interface SessionInjectEvent {
  session: string;
  message: string;
  from: string;
  channel?: { type: string; id: string; name?: string };
}

export interface SessionResponseEvent {
  session: string;
  message: string;
  response: string;
  from: string;
}

export interface SessionResponseChunkEvent extends SessionResponseEvent {
  chunk: string;
}

export interface SessionDestroyEvent {
  session: string;
  history: any[];
  reason?: string;
}

// Channel events
export interface ChannelMessageEvent {
  channel: { type: string; id: string; name?: string };
  message: string;
  from: string;
  metadata?: any;
}

export interface ChannelSendEvent {
  channel: { type: string; id: string };
  content: string;
}

// Plugin events
export interface PluginInitEvent {
  plugin: string;
  version: string;
}

export interface PluginErrorEvent {
  plugin: string;
  error: Error;
  context?: string;
}

// Config events
export interface ConfigChangeEvent {
  key: string;
  oldValue: any;
  newValue: any;
  plugin?: string;
}

// System events
export interface SystemShutdownEvent {
  reason: string;
  code?: number;
}

/**
 * Event map - all core events and their payloads
 */
export interface WOPREventMap {
  "session:create": SessionCreateEvent;
  "session:beforeInject": SessionInjectEvent;
  "session:afterInject": SessionResponseEvent;
  "session:responseChunk": SessionResponseChunkEvent;
  "session:destroy": SessionDestroyEvent;
  "channel:message": ChannelMessageEvent;
  "channel:send": ChannelSendEvent;
  "plugin:beforeInit": PluginInitEvent;
  "plugin:afterInit": PluginInitEvent;
  "plugin:error": PluginErrorEvent;
  "config:change": ConfigChangeEvent;
  "system:shutdown": SystemShutdownEvent;
  "*": WOPREvent;
}

/**
 * Event handler type
 */
export type EventHandler<T = any> = (payload: T, event: WOPREvent) => void | Promise<void>;

/**
 * Event bus interface - reactive primitive for plugins
 */
export interface WOPREventBus {
  /**
   * Subscribe to an event
   * @param event - Event name (e.g., 'session:create')
   * @param handler - Handler function
   * @returns Unsubscribe function
   */
  on<T extends keyof WOPREventMap>(
    event: T,
    handler: EventHandler<WOPREventMap[T]>
  ): () => void;

  /**
   * Subscribe to an event once
   * @param event - Event name
   * @param handler - Handler function
   */
  once<T extends keyof WOPREventMap>(
    event: T,
    handler: EventHandler<WOPREventMap[T]>
  ): void;

  /**
   * Unsubscribe from an event
   * @param event - Event name
   * @param handler - Handler function to remove
   */
  off<T extends keyof WOPREventMap>(
    event: T,
    handler: EventHandler<WOPREventMap[T]>
  ): void;

  /**
   * Emit an event (for custom inter-plugin events)
   * Use 'plugin:yourEvent' naming for custom events
   * @param event - Event name
   * @param payload - Event payload
   */
  emit<T extends keyof WOPREventMap>(
    event: T,
    payload: WOPREventMap[T]
  ): Promise<void>;

  /**
   * Emit a custom event (for inter-plugin communication)
   * @param event - Custom event name (use plugin: prefix)
   * @param payload - Event payload
   */
  emitCustom(
    event: string,
    payload: any
  ): Promise<void>;

  /**
   * Get number of listeners for an event
   */
  listenerCount(event: string): number;
}

/**
 * Hook event with mutable state (for before hooks)
 */
export interface MutableHookEvent<T> {
  data: T;
  session: string;
  /** Call to prevent further processing */
  preventDefault(): void;
  /** True if preventDefault was called */
  isPrevented(): boolean;
}

/**
 * Hook options - priority ordering and identification
 */
export interface HookOptions {
  /** Lower = runs first (default: 100) */
  priority?: number;
  /** Name for debugging and removal */
  name?: string;
  /** Run once then auto-remove */
  once?: boolean;
}

/**
 * Hook handler types
 */
export type MessageIncomingHandler = (event: MutableHookEvent<{ message: string; from: string; channel?: any }>) => void | Promise<void>;
export type MessageOutgoingHandler = (event: MutableHookEvent<{ response: string; from: string; channel?: any }>) => void | Promise<void>;
export type SessionCreateHandler = (event: { session: string; config?: any }) => void | Promise<void>;
export type SessionDestroyHandler = (event: { session: string; history: any[]; reason?: string }) => void | Promise<void>;
export type ChannelMessageHandler = (event: MutableHookEvent<{ channel: any; message: string; from: string; metadata?: any }>) => void | Promise<void>;

/**
 * Hook manager - typed hooks for core lifecycle events
 *
 * Mutable hooks (can transform data, call preventDefault()):
 * - message:incoming - transform/block incoming messages
 * - message:outgoing - transform/block outgoing responses
 * - channel:message - transform/block channel messages
 *
 * Read-only hooks (observe only):
 * - session:create - session created
 * - session:destroy - session destroyed
 */
export interface WOPRHookManager {
  // Mutable hooks - can transform data or block
  on(event: "message:incoming", handler: MessageIncomingHandler, options?: HookOptions): () => void;
  on(event: "message:outgoing", handler: MessageOutgoingHandler, options?: HookOptions): () => void;
  on(event: "channel:message", handler: ChannelMessageHandler, options?: HookOptions): () => void;

  // Read-only hooks - observe lifecycle
  on(event: "session:create", handler: SessionCreateHandler, options?: HookOptions): () => void;
  on(event: "session:destroy", handler: SessionDestroyHandler, options?: HookOptions): () => void;

  // Remove by handler reference
  off(event: "message:incoming", handler: MessageIncomingHandler): void;
  off(event: "message:outgoing", handler: MessageOutgoingHandler): void;
  off(event: "channel:message", handler: ChannelMessageHandler): void;
  off(event: "session:create", handler: SessionCreateHandler): void;
  off(event: "session:destroy", handler: SessionDestroyHandler): void;

  // Remove by name
  offByName(name: string): void;

  // List registered hooks
  list(): Array<{ event: string; name?: string; priority: number }>;
}

// ============================================================================
// Plugin Context
// ============================================================================

export interface WOPRPluginContext {
  // Inject into local session, get response (with optional streaming)
  // Supports multimodal messages with images
  inject(session: string, message: string | MultimodalMessage, options?: PluginInjectOptions): Promise<string>;

  // Log a message to conversation history without triggering a response
  // Useful for capturing context from messages not directed at the bot
  logMessage(session: string, message: string, options?: { from?: string; channel?: ChannelRef }): void;

  // Agent persona identity (from IDENTITY.md workspace file)
  getAgentIdentity(): AgentIdentity | Promise<AgentIdentity>;

  // User profile (from USER.md workspace file)
  getUserProfile(): UserProfile | Promise<UserProfile>;

  // Sessions
  getSessions(): string[];

  // Cancel an in-progress injection for a session
  // Returns true if there was an injection to cancel, false otherwise
  cancelInject(session: string): boolean;

  // Events - when sessions receive injections (deprecated, use events API)
  on(event: "injection", handler: InjectionHandler): void;
  on(event: "stream", handler: StreamHandler): void;
  off(event: "injection", handler: InjectionHandler): void;
  off(event: "stream", handler: StreamHandler): void;

  /**
   * Event bus for reactive plugin composition.
   * Exposes primitives - plugins compose their own behaviors.
   * 
   * @example
   * // Subscribe to session creation
   * ctx.events.on('session:create', ({ session, config }) => {
   *   ctx.logger.info(`Session ${session} created`);
   * });
   * 
   * // Emit custom events for inter-plugin communication
   * ctx.events.emit('myplugin:custom', { data: 'value' });
   * 
   * // Subscribe once
   * ctx.events.once('session:destroy', ({ session }) => {
   *   ctx.logger.info(`Session ${session} destroyed`);
   * });
   */
  events: WOPREventBus;

  /**
   * Register a hook - shorthand for common event patterns.
   * Hooks are typed event handlers for core lifecycle.
   * 
   * @example
   * // Hook before message injection (can modify message)
   * ctx.hooks.on('session:beforeInject', async (event) => {
   *   event.message = event.message.toUpperCase(); // mutate
   * });
   * 
   * // Hook after response (read-only)
   * ctx.hooks.on('session:afterInject', (event) => {
   *   analytics.track(event.session, event.response.length);
   * });
   */
  hooks: WOPRHookManager;

  // Context providers - plugins register context sources
  registerContextProvider(provider: ContextProvider): void;
  unregisterContextProvider(name: string): void;
  getContextProvider(name: string): ContextProvider | undefined;

  // Channels - plugins register message channels (e.g., Discord, P2P peers)
  registerChannel(adapter: ChannelAdapter): void;
  unregisterChannel(channel: ChannelRef): void;
  getChannel(channel: ChannelRef): ChannelAdapter | undefined;
  getChannels(): ChannelAdapter[];
  getChannelsForSession(session: string): ChannelAdapter[];

  // Web UI extensions - plugins register navigation links
  registerWebUiExtension(extension: WebUiExtension): void;
  unregisterWebUiExtension(id: string): void;
  getWebUiExtensions(): WebUiExtension[];

  // UI Component extensions - plugins register SolidJS components
  registerUiComponent(extension: UiComponentExtension): void;
  unregisterUiComponent(id: string): void;
  getUiComponents(): UiComponentExtension[];

  // Plugin's own config
  getConfig<T = any>(): T;
  saveConfig<T = any>(config: T): Promise<void>;

  // Main WOPR config (read-only access)
  getMainConfig(key?: string): any;

  // Model providers - plugins register AI model providers
  registerProvider(provider: import("./types/provider.js").ModelProvider): void;
  unregisterProvider(id: string): void;
  getProvider(id: string): import("./types/provider.js").ModelProvider | undefined;

  // Config schemas - plugins register their configuration UI schema
  registerConfigSchema(pluginId: string, schema: ConfigSchema): void;
  unregisterConfigSchema(pluginId: string): void;
  getConfigSchema(pluginId: string): ConfigSchema | undefined;

  // Plugin extensions - plugins can expose APIs to other plugins
  // Example: P2P plugin registers ctx.registerExtension("p2p", { injectPeer, getIdentity, getPeers })
  // Other plugins access via ctx.getExtension<P2PExtension>("p2p")
  registerExtension(name: string, extension: unknown): void;
  unregisterExtension(name: string): void;
  getExtension<T = unknown>(name: string): T | undefined;
  listExtensions(): string[];

  // Voice providers - STT and TTS plugins register providers
  // Channel plugins discover via getSTT()/getTTS() or getExtension('stt'/'tts')
  registerSTTProvider(provider: import("./voice/types.js").STTProvider): void;
  registerTTSProvider(provider: import("./voice/types.js").TTSProvider): void;
  getSTT(): import("./voice/types.js").STTProvider | null;
  getTTS(): import("./voice/types.js").TTSProvider | null;
  hasVoice(): { stt: boolean; tts: boolean };

  // A2A (Agent-to-Agent) tools - plugins register MCP tools
  // Example: P2P plugin registers p2p_join_topic, p2p_send_message, etc.
  registerA2AServer?(config: A2AServerConfig): void;

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
