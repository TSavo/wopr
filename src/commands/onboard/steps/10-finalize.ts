/**
 * Step 10: Finalize and complete
 */
import { note, outro, confirm, pc } from "../prompts.js";
import { openBrowser, applyWizardMetadata } from "../helpers.js";
import { config } from "../../../core/config.js";
import type { OnboardContext, OnboardStep } from "../types.js";

export const finalizeStep: OnboardStep = async (ctx: OnboardContext) => {
  // Apply wizard metadata
  const finalConfig = await applyWizardMetadata(ctx.nextConfig, {
    command: "onboard",
    mode: ctx.opts.mode || ctx.opts.flow,
  });
  
  // Save config
  await config.load();
  Object.entries(finalConfig).forEach(([key, value]) => {
    if (value !== undefined) {
      config.setValue(key, value);
    }
  });
  await config.save();
  
  ctx.runtime.log("Configuration saved!");
  
  // Build summary
  const port = finalConfig.gateway?.port || 3000;
  const token = finalConfig.gateway?.auth?.token;
  const webUiUrl = `http://127.0.0.1:${port}`;
  const authedUrl = token ? `${webUiUrl}?token=${encodeURIComponent(token)}` : webUiUrl;
  
  await note([
    pc.green("✓") + " Workspace configured",
    finalConfig.provider?.primary ? pc.green("✓") + " AI provider: " + finalConfig.provider.primary : pc.yellow("○") + " AI provider: Not configured",
    finalConfig.channels?.length ? pc.green("✓") + " Channels: " + finalConfig.channels.join(", ") : pc.dim("○ Channels: None"),
    finalConfig.skills?.length ? pc.green("✓") + " Skills: " + finalConfig.skills.join(", ") : pc.dim("○ Skills: None"),
    pc.green("✓") + " Gateway configured",
    "",
    `Web UI: ${webUiUrl}`,
    token ? `Web UI (with token): ${authedUrl}` : "",
    "",
    pc.dim("Next steps:"),
    "  • Open the Web UI to start chatting",
    "  • Edit ~/.wopr/workspace/IDENTITY.md to customize your agent",
    "  • Edit ~/.wopr/workspace/SOUL.md to set boundaries",
  ].filter(Boolean).join("\n"), "Setup Complete");
  
  // Check for BOOTSTRAP.md
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const bootstrapPath = path.join(finalConfig.workspace || "~/.wopr/workspace", "BOOTSTRAP.md");
  
  let hasBootstrap = false;
  try {
    await fs.access(bootstrapPath);
    hasBootstrap = true;
  } catch {
    hasBootstrap = false;
  }
  
  if (hasBootstrap) {
    await note([
      "BOOTSTRAP.md detected!",
      "",
      "This is your agent's first-run ritual.",
      "Open the Web UI and say:",
      pc.cyan('  "Wake up, my friend!"'),
      "",
      "Your agent will guide you through setting up:",
      "  • Its name and identity",
      "  • Your user profile",
      "  • Preferred communication style",
    ].join("\n"), "🐣 First Run");
  }
  
  // Ask to open browser
  if (!ctx.opts.skipUi) {
    const openNow = await confirm({
      message: "Open Web UI in browser?",
      initialValue: true,
    });
    
    if (openNow) {
      const opened = await openBrowser(authedUrl);
      if (opened) {
        ctx.runtime.log("Browser opened!");
      } else {
        await note([
          "Could not open browser automatically.",
          "",
          `Please open: ${authedUrl}`,
        ].join("\n"), "Open Web UI");
      }
    }
  }
  
  // Helpful commands
  await note([
    pc.cyan("wopr daemon start") + "     Start the gateway daemon",
    pc.cyan("wopr daemon stop") + "      Stop the gateway daemon",
    pc.cyan("wopr status") + "           Check system status",
    pc.cyan("wopr configure") + "        Reconfigure settings",
    pc.cyan("wopr onboard") + "          Run this wizard again",
    "",
    pc.dim("Docs: https://github.com/TSavo/wopr"),
    pc.dim("Issues: https://github.com/TSavo/wopr/issues"),
  ].join("\n"), "Useful Commands");
  
  await outro(pc.green("🚀 WOPR is ready! Happy chatting!"));
  
  return {};
};
