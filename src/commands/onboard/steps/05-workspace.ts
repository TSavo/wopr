/**
 * Step 5: Workspace setup
 */
import { text, note, spinner, pc } from "../prompts.js";
import { DEFAULT_WORKSPACE } from "../helpers.js";
import { ensureWorkspace } from "../../../core/workspace.js";
import type { OnboardContext, OnboardStep } from "../types.js";

export const workspaceStep: OnboardStep = async (ctx: OnboardContext) => {
  const isQuickstart = ctx.opts.flow === "quickstart";
  
  // Determine workspace directory
  let workspaceDir: string;
  
  if (ctx.opts.workspace) {
    // CLI override
    workspaceDir = ctx.opts.workspace;
  } else if (isQuickstart && ctx.nextConfig.workspace) {
    // Use existing from config check
    workspaceDir = ctx.nextConfig.workspace;
  } else if (isQuickstart) {
    // QuickStart default
    workspaceDir = DEFAULT_WORKSPACE;
  } else {
    // Advanced: prompt for workspace
    workspaceDir = await text({
      message: "Workspace directory",
      initialValue: ctx.nextConfig.workspace || DEFAULT_WORKSPACE,
      validate: (value) => {
        if (!value.trim()) return "Workspace directory is required";
      },
    });
  }
  
  // Create workspace
  const s = await spinner();
  s.start("Setting up workspace...");
  
  try {
    const { dir, created } = await ensureWorkspace(workspaceDir);
    
    if (created) {
      s.stop("Workspace created!");
      
      await note([
        `Created at: ${dir}`,
        "",
        "Files created:",
        "  • AGENTS.md - Operating instructions",
        "  • SOUL.md - Persona and boundaries",
        "  • TOOLS.md - Tool notes",
        "  • IDENTITY.md - Agent name/emoji",
        "  • USER.md - Your profile",
        "  • BOOTSTRAP.md - First run ritual",
        "",
        pc.yellow("💡 Tip: Edit these files to customize your agent!"),
      ].join("\n"), "Workspace");
    } else {
      s.stop("Using existing workspace");
      
      await note([
        `Workspace: ${dir}`,
        "",
        pc.dim("Existing bootstrap files preserved."),
        "",
        pc.yellow("💡 Tip: Check BOOTSTRAP.md if you haven't completed the first-run ritual."),
      ].join("\n"), "Workspace");
    }
    
    return { workspace: dir };
  } catch (err: any) {
    s.stop("Failed to create workspace");
    throw new Error(`Workspace setup failed: ${err.message}`);
  }
};
