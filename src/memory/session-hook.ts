// Session memory hook - saves session content when session ends
// Adapted from OpenClaw for WOPR
import fs from "node:fs/promises";
import path from "node:path";
import { SESSIONS_DIR, WOPR_HOME } from "../paths.js";
import { getConversationLogPath } from "../core/sessions.js";
import { getRecentSessionContent } from "./session-files.js";

const MEMORY_DIR = path.join(WOPR_HOME, "memory");

/**
 * Generate a simple slug from session content
 * Uses basic keyword extraction (no LLM call - keeps it simple)
 */
function generateSlugFromContent(content: string): string {
  // Extract keywords from conversation
  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .filter((w) => !["user", "assistant", "that", "this", "with", "from", "have", "what", "your", "about"].includes(w));

  // Count word frequency
  const freq = new Map<string, number>();
  for (const word of words) {
    freq.set(word, (freq.get(word) || 0) + 1);
  }

  // Get top 2 keywords by frequency
  const sorted = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([word]) => word);

  if (sorted.length === 0) {
    return "session";
  }

  return sorted.join("-").slice(0, 30);
}

/**
 * Save session content to memory when session ends
 */
export async function saveSessionToMemory(sessionName: string): Promise<string | null> {
  try {
    // Get conversation log path
    const conversationPath = getConversationLogPath(sessionName);

    // Get recent messages from session
    const sessionContent = await getRecentSessionContent(conversationPath, 20);
    if (!sessionContent || sessionContent.trim().length < 50) {
      // Skip if too short
      return null;
    }

    // Ensure memory directory exists
    await fs.mkdir(MEMORY_DIR, { recursive: true });

    // Generate filename with date and slug
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const slug = generateSlugFromContent(sessionContent);
    const filename = `${dateStr}-${slug}.md`;
    const memoryFilePath = path.join(MEMORY_DIR, filename);

    // Check if file already exists - append if so
    let existingContent = "";
    try {
      existingContent = await fs.readFile(memoryFilePath, "utf-8");
      existingContent += "\n---\n\n";
    } catch {
      // File doesn't exist, that's fine
    }

    // Format time as HH:MM:SS UTC
    const timeStr = now.toISOString().split("T")[1].split(".")[0];

    // Build Markdown entry
    const entry = [
      existingContent,
      `# Session: ${sessionName}`,
      `*${dateStr} ${timeStr} UTC*`,
      "",
      "## Conversation Summary",
      "",
      sessionContent,
      "",
    ].join("\n");

    // Write to memory file
    await fs.writeFile(memoryFilePath, entry, "utf-8");

    return memoryFilePath;
  } catch (err) {
    console.error(
      "[session-memory] Failed to save session memory:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Hook handler for session:destroy event
 */
export function createSessionDestroyHandler(): (sessionName: string, reason?: string) => Promise<void> {
  return async (sessionName: string, reason?: string) => {
    // Only save on reset (/new) or explicit delete, not on error cleanup
    if (reason === "error") {
      return;
    }

    const savedPath = await saveSessionToMemory(sessionName);
    if (savedPath) {
      console.log(`[session-memory] Saved to ${savedPath.replace(WOPR_HOME, "~/.wopr")}`);
    }
  };
}
