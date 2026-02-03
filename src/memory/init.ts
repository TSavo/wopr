// Memory system initialization - wires up session hooks
import { eventBus } from "../core/events.js";
import { createSessionDestroyHandler } from "./session-hook.js";

let initialized = false;

/**
 * Initialize the memory system hooks
 * This should be called once during WOPR startup
 */
export function initMemoryHooks(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  const sessionDestroyHandler = createSessionDestroyHandler();

  // Register session:destroy handler to save conversation to memory
  eventBus.on("session:destroy", async (payload) => {
    await sessionDestroyHandler(payload.session, payload.reason);
  });

  console.log("[memory] Session memory hooks initialized");
}
