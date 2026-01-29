/**
 * Step 3: Check existing config
 */
import { select, note, confirm, pc } from "../prompts.js";
import { summarizeExistingConfig, DEFAULT_WORKSPACE } from "../helpers.js";
import { config } from "../../../core/config.js";
import type { OnboardContext, OnboardStep, OnboardConfig } from "../types.js";

export const configCheckStep: OnboardStep = async (ctx: OnboardContext) => {
  // Load current config
  await config.load();
  const currentConfig = config.get() as unknown as OnboardConfig;
  
  // Check if we have meaningful config
  const hasExisting = currentConfig.provider?.primary || 
                     currentConfig.workspace ||
                     currentConfig.gateway?.port;
  
  if (!hasExisting) {
    await note("No existing configuration found. Starting fresh setup.", "Configuration");
    return {};
  }
  
  // Show existing config
  await note(summarizeExistingConfig(currentConfig), "Existing Configuration");
  
  // Ask what to do
  const action = await select<"keep" | "modify" | "reset">({
    message: "Configuration handling",
    options: [
      { value: "keep", label: "Use existing values", hint: "Keep current settings" },
      { value: "modify", label: "Update values", hint: "Change some settings" },
      { value: "reset", label: "Reset everything", hint: "Start from scratch" },
    ],
    initialValue: "keep",
  });
  
  if (action === "reset") {
    const confirmReset = await confirm({
      message: pc.red("This will delete all WOPR configuration. Are you sure?"),
      initialValue: false,
    });
    
    if (!confirmReset) {
      return configCheckStep(ctx); // Go back to selection
    }
    
    // Reset config (but we'll do a soft reset - just clear our keys)
    ctx.runtime.log("Resetting configuration...");
    return {
      workspace: DEFAULT_WORKSPACE,
      provider: undefined,
      gateway: undefined,
      channels: [],
      skills: [],
      plugins: [],
    };
  }
  
  if (action === "keep") {
    // Return existing config as base
    return {
      workspace: currentConfig.workspace || DEFAULT_WORKSPACE,
      provider: currentConfig.provider,
      gateway: currentConfig.gateway,
      channels: currentConfig.channels || [],
      skills: currentConfig.skills || [],
      plugins: currentConfig.plugins || [],
    };
  }
  
  // "modify" - return current config, wizard will update selectively
  return {
    workspace: currentConfig.workspace || DEFAULT_WORKSPACE,
    provider: currentConfig.provider,
    gateway: currentConfig.gateway,
    channels: currentConfig.channels || [],
    skills: currentConfig.skills || [],
    plugins: currentConfig.plugins || [],
  };
};
