/**
 * WOPR Onboard Wizard
 * 
 * Interactive setup wizard for WOPR.
 * Run with: wopr onboard
 */
import { p, pc } from "./prompts.js";
import type { OnboardOptions, OnboardRuntime, OnboardConfig, OnboardContext } from "./types.js";

// Import steps
import { welcomeStep } from "./steps/01-welcome.js";
import { securityStep } from "./steps/02-security.js";
import { configCheckStep } from "./steps/03-config-check.js";
import { flowStep } from "./steps/04-flow.js";
import { workspaceStep } from "./steps/05-workspace.js";
import { providersStep } from "./steps/06-providers.js";
import { channelsStep } from "./steps/07-channels.js";
import { skillsStep } from "./steps/08-skills.js";
import { daemonStep } from "./steps/09-daemon.js";
import { finalizeStep } from "./steps/10-finalize.js";

const steps = [
  welcomeStep,
  securityStep,
  configCheckStep,
  flowStep,
  workspaceStep,
  providersStep,
  channelsStep,
  skillsStep,
  daemonStep,
  finalizeStep,
];

export async function runOnboardWizard(
  opts: OnboardOptions = {},
  runtime: OnboardRuntime = {
    log: console.log,
    error: console.error,
    exit: process.exit,
  }
): Promise<void> {
  // Ensure cleanup on exit
  p.intro(pc.cyan("WOPR Onboarding"));
  
  // Build context
  const ctx: OnboardContext = {
    opts,
    runtime,
    baseConfig: {},
    nextConfig: {},
  };
  
  try {
    // Run each step
    for (const step of steps) {
      const updates = await step(ctx);
      
      // Merge updates into nextConfig
      if (updates) {
        ctx.nextConfig = {
          ...ctx.nextConfig,
          ...updates,
        };
      }
    }
    
    runtime.exit(0);
  } catch (err: any) {
    if (err.name === "WizardCancelledError") {
      p.cancel(pc.red(err.message || "Onboarding cancelled."));
      runtime.exit(0);
    }
    
    p.log.error(pc.red(`Onboarding failed: ${err.message}`));
    runtime.error(err.message);
    runtime.exit(1);
  }
}

// CLI handler
export async function onboardCommand(args: string[]): Promise<void> {
  const opts: OnboardOptions = {};
  
  // Parse args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    switch (arg) {
      case "--quickstart":
      case "-q":
        opts.flow = "quickstart";
        break;
      case "--advanced":
      case "-a":
        opts.flow = "advanced";
        break;
      case "--reset":
      case "-r":
        opts.reset = true;
        break;
      case "--skip-channels":
        opts.skipChannels = true;
        break;
      case "--skip-skills":
        opts.skipSkills = true;
        break;
      case "--skip-plugins":
        opts.skipPlugins = true;
        break;
      case "--skip-daemon":
        opts.skipDaemon = true;
        break;
      case "--skip-ui":
        opts.skipUi = true;
        break;
      case "--accept-risk":
        opts.acceptRisk = true;
        break;
      case "--workspace":
      case "-w":
        opts.workspace = args[++i];
        break;
      case "--help":
      case "-h":
        showHelp();
        process.exit(0);
        break;
    }
  }
  
  await runOnboardWizard(opts);
}

function showHelp(): void {
  console.log(`
${pc.cyan("WOPR Onboard Wizard")}

Usage: wopr onboard [options]

Interactive setup wizard for WOPR.

Options:
  -q, --quickstart      Use QuickStart mode (minimal prompts)
  -a, --advanced        Use Advanced mode (full configuration)
  -r, --reset           Reset existing configuration first
  -w, --workspace PATH  Set workspace directory
      --skip-channels   Skip channel/plugin setup
      --skip-skills     Skip skills setup
      --skip-plugins    Skip plugin installation
      --skip-daemon     Skip daemon/service setup
      --skip-ui         Skip WebUI open prompts
      --accept-risk     Accept security warning automatically
  -h, --help            Show this help

Examples:
  wopr onboard                    # Interactive wizard
  wopr onboard --quickstart       # Minimal setup with defaults
  wopr onboard --reset            # Start fresh
  wopr onboard --skip-channels    # Skip Discord setup
`);
}

export { OnboardOptions, OnboardRuntime, OnboardConfig } from "./types.js";
