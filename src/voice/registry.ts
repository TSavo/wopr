/**
 * WOPR Voice Registry
 *
 * Manages STT and TTS provider registration and discovery.
 */

import { EventEmitter } from "events";
import type {
  STTProvider,
  TTSProvider,
  VoiceRegistry,
} from "./types.js";

export class WOPRVoiceRegistry extends EventEmitter implements VoiceRegistry {
  private sttProviders = new Map<string, STTProvider>();
  private ttsProviders = new Map<string, TTSProvider>();
  private activeSTT: string | null = null;
  private activeTTS: string | null = null;

  /**
   * Register an STT provider
   */
  registerSTT(provider: STTProvider): void {
    const name = provider.metadata.name;

    // Validate config before registering
    provider.validateConfig();

    this.sttProviders.set(name, provider);

    // First registered becomes active by default
    if (!this.activeSTT) {
      this.activeSTT = name;
    }

    this.emit("stt:registered", { name, provider });
    console.log(`[voice] STT registered: ${name} (${provider.metadata.description})`);
  }

  /**
   * Register a TTS provider
   */
  registerTTS(provider: TTSProvider): void {
    const name = provider.metadata.name;

    // Validate config before registering
    provider.validateConfig();

    this.ttsProviders.set(name, provider);

    // First registered becomes active by default
    if (!this.activeTTS) {
      this.activeTTS = name;
    }

    this.emit("tts:registered", { name, provider });
    console.log(`[voice] TTS registered: ${name} (${provider.metadata.description})`);
  }

  /**
   * Get the active STT provider
   */
  getSTT(): STTProvider | null {
    if (!this.activeSTT) return null;
    return this.sttProviders.get(this.activeSTT) ?? null;
  }

  /**
   * Get the active TTS provider
   */
  getTTS(): TTSProvider | null {
    if (!this.activeTTS) return null;
    return this.ttsProviders.get(this.activeTTS) ?? null;
  }

  /**
   * List all registered STT providers
   */
  listSTT(): STTProvider[] {
    return Array.from(this.sttProviders.values());
  }

  /**
   * List all registered TTS providers
   */
  listTTS(): TTSProvider[] {
    return Array.from(this.ttsProviders.values());
  }

  /**
   * Set the active STT provider by name
   */
  setActiveSTT(name: string): boolean {
    if (!this.sttProviders.has(name)) {
      return false;
    }
    this.activeSTT = name;
    this.emit("stt:activated", { name });
    console.log(`[voice] STT activated: ${name}`);
    return true;
  }

  /**
   * Set the active TTS provider by name
   */
  setActiveTTS(name: string): boolean {
    if (!this.ttsProviders.has(name)) {
      return false;
    }
    this.activeTTS = name;
    this.emit("tts:activated", { name });
    console.log(`[voice] TTS activated: ${name}`);
    return true;
  }

  /**
   * Get STT provider by name
   */
  getSTTByName(name: string): STTProvider | null {
    return this.sttProviders.get(name) ?? null;
  }

  /**
   * Get TTS provider by name
   */
  getTTSByName(name: string): TTSProvider | null {
    return this.ttsProviders.get(name) ?? null;
  }

  /**
   * Find providers by capability
   */
  findSTTByCapability(capability: string): STTProvider[] {
    return this.listSTT().filter(p =>
      p.metadata.capabilities.includes(capability)
    );
  }

  findTTSByCapability(capability: string): TTSProvider[] {
    return this.listTTS().filter(p =>
      p.metadata.capabilities.includes(capability)
    );
  }

  /**
   * Find local (non-cloud) providers
   */
  getLocalSTT(): STTProvider[] {
    return this.listSTT().filter(p => p.metadata.local);
  }

  getLocalTTS(): TTSProvider[] {
    return this.listTTS().filter(p => p.metadata.local);
  }

  /**
   * Health check all cloud providers
   */
  async healthCheckAll(): Promise<{ stt: Record<string, boolean>; tts: Record<string, boolean> }> {
    const sttResults: Record<string, boolean> = {};
    const ttsResults: Record<string, boolean> = {};

    for (const [name, provider] of this.sttProviders) {
      if (provider.healthCheck && !provider.metadata.local) {
        try {
          sttResults[name] = await provider.healthCheck();
        } catch {
          sttResults[name] = false;
        }
      } else {
        sttResults[name] = true; // Local providers assumed healthy
      }
    }

    for (const [name, provider] of this.ttsProviders) {
      if (provider.healthCheck && !provider.metadata.local) {
        try {
          ttsResults[name] = await provider.healthCheck();
        } catch {
          ttsResults[name] = false;
        }
      } else {
        ttsResults[name] = true; // Local providers assumed healthy
      }
    }

    return { stt: sttResults, tts: ttsResults };
  }

  /**
   * Shutdown all providers
   */
  async shutdown(): Promise<void> {
    const shutdowns: Promise<void>[] = [];

    for (const provider of this.sttProviders.values()) {
      if (provider.shutdown) {
        shutdowns.push(provider.shutdown());
      }
    }

    for (const provider of this.ttsProviders.values()) {
      if (provider.shutdown) {
        shutdowns.push(provider.shutdown());
      }
    }

    await Promise.all(shutdowns);

    this.sttProviders.clear();
    this.ttsProviders.clear();
    this.activeSTT = null;
    this.activeTTS = null;

    console.log("[voice] All providers shut down");
  }
}

// Singleton instance
let voiceRegistry: WOPRVoiceRegistry | null = null;

export function getVoiceRegistry(): WOPRVoiceRegistry {
  if (!voiceRegistry) {
    voiceRegistry = new WOPRVoiceRegistry();
  }
  return voiceRegistry;
}

export function resetVoiceRegistry(): void {
  if (voiceRegistry) {
    voiceRegistry.shutdown().catch(console.error);
  }
  voiceRegistry = null;
}
