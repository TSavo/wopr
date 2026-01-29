/**
 * Step 2: Security acknowledgment
 */
import { confirm, note, pc, WizardCancelledError } from "../prompts.js";
import type { OnboardContext, OnboardStep } from "../types.js";

export const securityStep: OnboardStep = async (ctx: OnboardContext) => {
  // Skip if already accepted via flag
  if (ctx.opts.acceptRisk) {
    return {};
  }
  
  await note([
    "WOPR is an AI agent that can:",
    "",
    "  • Execute shell commands",
    "  • Read and write files",
    "  • Send messages via configured channels",
    "  • Access your configured API keys",
    "",
    pc.yellow("⚠️  Security warnings:"),
    "  • Store API keys securely (they're saved to ~/.wopr/config.json)",
    "  • Review file changes before committing",
    "  • Don't expose the gateway to the public internet without auth",
    "  • Run destructive commands only when explicitly asked",
    "",
    pc.blue("Learn more: https://github.com/TSavo/wopr#security"),
  ].join("\n"), "Security Notice");
  
  const accepted = await confirm({
    message: "I understand the risks and want to continue?",
    initialValue: false,
  });
  
  if (!accepted) {
    throw new WizardCancelledError("Security acknowledgment required");
  }
  
  return {};
};
