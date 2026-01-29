/**
 * Step 1: Welcome header
 */
import { intro, printHeader, note, pc } from "../prompts.js";
import type { OnboardContext, OnboardStep } from "../types.js";

export const welcomeStep: OnboardStep = async (ctx: OnboardContext) => {
  printHeader();
  await intro("WOPR Onboarding");
  
  await note([
    "This wizard will help you set up WOPR:",
    "",
    "  • Configure your AI model provider",
    "  • Set up workspace (AGENTS.md, SOUL.md, etc.)",
    "  • Install channel plugins (Discord, P2P)",
    "  • Install useful skills",
    "  • Configure the gateway daemon",
    "",
    pc.dim("You can re-run this anytime with: wopr onboard"),
  ].join("\n"), "What we'll do");
  
  return {};
};
