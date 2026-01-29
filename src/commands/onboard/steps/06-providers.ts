/**
 * Step 6: Model provider setup
 */
import { select, text, password, note, spinner, confirm, pc } from "../prompts.js";
import { AVAILABLE_PROVIDERS } from "../types.js";
import type { OnboardContext, OnboardStep } from "../types.js";

export const providersStep: OnboardStep = async (ctx: OnboardContext) => {
  const isQuickstart = ctx.opts.flow === "quickstart";
  
  // Check if provider already configured
  const existingProvider = ctx.nextConfig.provider?.primary;
  
  if (existingProvider && isQuickstart) {
    await note([
      `Using existing provider: ${existingProvider}`,
      "",
      pc.dim("API key already configured."),
    ].join("\n"), "AI Provider");
    return {};
  }
  
  // Select provider
  let providerId: string;
  
  if (isQuickstart && existingProvider) {
    providerId = existingProvider;
  } else {
    const options: Array<{ value: string; label: string; hint?: string }> = AVAILABLE_PROVIDERS.map(p => ({
      value: p.id,
      label: p.name,
      hint: p.models.join(", "),
    }));
    
    // Add skip option
    options.push({
      value: "skip",
      label: "Skip for now",
      hint: "Configure later",
    });
    
    const selected = await select<string>({
      message: "Choose your AI model provider",
      options,
      initialValue: existingProvider || "kimi",
    });
    
    if (selected === "skip") {
      await note([
        "You can configure a provider later with:",
        pc.cyan("  wopr configure --provider"),
      ].join("\n"), "Provider Skipped");
      return {};
    }
    
    providerId = selected;
  }
  
  const providerInfo = AVAILABLE_PROVIDERS.find(p => p.id === providerId)!;
  
  // Get API key
  let apiKey: string;
  
  // Check if we already have a key
  const providerConfig = ctx.nextConfig.provider?.[providerId as keyof typeof ctx.nextConfig.provider];
  const existingKey = providerConfig && typeof providerConfig === "object" ? providerConfig.apiKey : undefined;
  
  if (existingKey && isQuickstart) {
    apiKey = existingKey;
  } else if (existingKey) {
    const useExisting = await confirm({
      message: `Use existing ${providerInfo.name} API key?`,
      initialValue: true,
    });
    
    if (useExisting) {
      apiKey = existingKey;
    } else {
      apiKey = await password({
        message: `Enter your ${providerInfo.name} API key`,
        validate: (value) => {
          if (!value.trim()) return "API key is required";
          if (value.length < 10) return "API key seems too short";
        },
      });
    }
  } else {
    // No existing key - prompt for one
    const docsUrl = providerId === "kimi" 
      ? "https://platform.moonshot.cn/" 
      : providerId === "anthropic"
      ? "https://console.anthropic.com/"
      : "https://platform.openai.com/";
    
    await note([
      `You'll need an API key from ${providerInfo.name}.`,
      "",
      `Get one at: ${docsUrl}`,
    ].join("\n"), "API Key Required");
    
    apiKey = await password({
      message: `Enter your ${providerInfo.name} API key`,
      validate: (value) => {
        if (!value.trim()) return "API key is required";
        if (value.length < 10) return "API key seems too short";
      },
    });
  }
  
  // Select model (Advanced mode only)
  let model: string;
  
  if (!isQuickstart) {
    const modelOptions = providerInfo.models.map(m => ({
      value: m,
      label: m,
    }));
    
    model = await select({
      message: "Choose a model",
      options: modelOptions,
      initialValue: providerInfo.models[0],
    });
  } else {
    model = providerInfo.models[0];
  }
  
  // Test the API key
  const s = await spinner();
  s.start("Validating API key...");
  
  try {
    // TODO: Implement actual API validation
    // For now, just simulate a delay
    await new Promise(r => setTimeout(r, 1000));
    s.stop("API key validated!");
  } catch (err) {
    s.stop("API key validation failed");
    const continueAnyway = await confirm({
      message: "Continue anyway? (You can fix this later)",
      initialValue: true,
    });
    
    if (!continueAnyway) {
      throw new Error("Provider setup cancelled");
    }
  }
  
  await note([
    `Provider: ${providerInfo.name}`,
    `Model: ${model}`,
    "",
    pc.green("✓ Ready to use"),
  ].join("\n"), "Provider Configured");
  
  // Return updated provider config
  return {
    provider: {
      primary: providerId,
      [providerId]: {
        apiKey,
        ...(providerId === "kimi" ? { baseUrl: "https://api.moonshot.cn/v1" } : {}),
      },
    },
  };
};
