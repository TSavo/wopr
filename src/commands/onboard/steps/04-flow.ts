/**
 * Step 4: Select flow mode (QuickStart vs Advanced)
 */
import { select, note, pc } from "../prompts.js";
import type { OnboardContext, OnboardStep } from "../types.js";

export const flowStep: OnboardStep = async (ctx: OnboardContext) => {
  // If flow is specified via CLI flag, use it
  if (ctx.opts.flow) {
    return {};
  }
  
  const flow = await select<"quickstart" | "advanced">({
    message: "Onboarding mode",
    options: [
      { 
        value: "quickstart", 
        label: "QuickStart", 
        hint: "Recommended defaults, minimal prompts",
      },
      { 
        value: "advanced", 
        label: "Advanced", 
        hint: "Full control over all settings",
      },
    ],
    initialValue: "quickstart",
  });
  
  // Store in options for other steps to use
  ctx.opts.flow = flow;
  
  if (flow === "quickstart") {
    await note([
      "QuickStart will use these defaults:",
      "",
      "  • Workspace: ~/.wopr/workspace",
      "  • Gateway port: 3000",
      "  • Gateway bind: Loopback (127.0.0.1)",
      "  • Auth: Token-based",
      "  • Provider: You'll still need to choose",
      "",
      pc.dim("You can change any of these later with: wopr configure"),
    ].join("\n"), "QuickStart Defaults");
  }
  
  return {};
};
