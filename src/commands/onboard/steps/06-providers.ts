/**
 * Step 6: Model provider setup
 *
 * Flow:
 * 1. Pick provider from available plugins
 * 2. Install the plugin
 * 3. Query plugin for auth methods and models
 * 4. Let user choose auth method if multiple available
 * 5. Configure credentials based on chosen method
 */
import { select, password, note, spinner, confirm, pc } from "../prompts.js";
import { AVAILABLE_PROVIDERS } from "../types.js";
import { installPlugin } from "../../../plugins.js";
import { providerRegistry } from "../../../core/providers.js";
import type { OnboardContext, OnboardStep } from "../types.js";

export const providersStep: OnboardStep = async (ctx: OnboardContext) => {
  const isQuickstart = ctx.opts.flow === "quickstart";

  // Check if provider already configured
  const existingProvider = ctx.nextConfig.provider?.primary;

  if (existingProvider && isQuickstart) {
    await note([
      `Using existing provider: ${existingProvider}`,
    ].join("\n"), "AI Provider");
    return {};
  }

  // Build provider options from available plugins
  const options = AVAILABLE_PROVIDERS.map(p => ({
    value: p.id,
    label: p.name,
  }));

  options.push({
    value: "skip",
    label: "Skip for now",
  });

  const providerId = await select<string>({
    message: "Choose your AI model provider",
    options,
    initialValue: existingProvider || "anthropic",
  });

  if (providerId === "skip") {
    await note([
      "You can configure a provider later with:",
      pc.cyan("  wopr configure --provider"),
    ].join("\n"), "Provider Skipped");
    return {};
  }

  const providerInfo = AVAILABLE_PROVIDERS.find(p => p.id === providerId)!;

  // Install provider plugin
  const s = await spinner();
  s.start(`Installing ${providerInfo.name} provider...`);
  try {
    await installPlugin(providerInfo.npm);
    s.stop(`${providerInfo.name} provider installed!`);
  } catch (err: any) {
    s.stop(`Provider install failed: ${err.message}`);
    const continueAnyway = await confirm({
      message: "Continue without provider? (You can install later)",
      initialValue: false,
    });
    if (!continueAnyway) {
      return {};
    }
  }

  // Query the installed provider for its capabilities
  const provider = providerRegistry.listProviders().find(p => p.id === providerId);

  if (!provider) {
    await note([
      "Provider plugin installed but not yet loaded.",
      "Restart the daemon to activate it.",
    ].join("\n"), "Note");
    return {
      provider: {
        primary: providerId,
      },
    };
  }

  // Get provider registration to access extended methods
  const reg = (providerRegistry as any).providers?.get(providerId);
  const providerImpl = reg?.provider;

  // Query auth methods from the plugin
  const authMethods = providerImpl?.getAuthMethods?.() || [];
  const activeAuth = providerImpl?.getActiveAuthMethod?.() || "none";
  const hasCredentials = providerImpl?.hasCredentials?.() || false;

  let selectedAuthMethod: string;
  let apiKey: string | undefined;

  // If plugin exposes auth methods, let user choose
  if (authMethods.length > 0) {
    const availableMethods = authMethods.filter((m: any) => m.available);
    const unavailableMethods = authMethods.filter((m: any) => !m.available);

    // In quickstart, auto-select the active method if credentials exist
    if (isQuickstart && hasCredentials) {
      selectedAuthMethod = activeAuth;
      const method = authMethods.find((m: any) => m.id === activeAuth);
      if (method) {
        await note([
          pc.green(`✓ Using ${method.name}`),
          "",
          ...(method.setupInstructions || []),
        ].join("\n"), "Authentication");
      }
    } else {
      // Show all auth options
      const authOptions = authMethods.map((m: any) => ({
        value: m.id,
        label: `${m.name}${m.available ? pc.green(" ✓") : pc.dim(" (setup required)")}`,
        hint: m.description,
      }));

      selectedAuthMethod = await select<string>({
        message: "Choose authentication method",
        options: authOptions,
        initialValue: activeAuth !== "none" ? activeAuth : authMethods[0]?.id,
      });

      const chosenMethod = authMethods.find((m: any) => m.id === selectedAuthMethod);

      if (chosenMethod) {
        if (!chosenMethod.available) {
          // Show setup instructions
          await note([
            `${chosenMethod.name} requires setup:`,
            "",
            ...(chosenMethod.setupInstructions || []),
            "",
            chosenMethod.docsUrl ? `Docs: ${pc.cyan(chosenMethod.docsUrl)}` : "",
          ].filter(Boolean).join("\n"), "Setup Required");
        }

        // If this method requires input (like API key)
        if (chosenMethod.requiresInput) {
          apiKey = await password({
            message: chosenMethod.inputLabel || "Enter credential",
            validate: (value) => {
              if (!value.trim()) return "Value is required";
              if (value.length < 10) return "Value seems too short";
            },
          });

          // Validate the credential
          const s2 = await spinner();
          s2.start("Validating credential...");

          try {
            const valid = await providerImpl?.validateCredentials?.(apiKey);
            if (valid) {
              s2.stop("Credential validated!");
            } else {
              s2.stop("Validation failed");
              const continueAnyway = await confirm({
                message: "Continue anyway? (You can fix this later)",
                initialValue: true,
              });
              if (!continueAnyway) {
                throw new Error("Provider setup cancelled");
              }
            }
          } catch (err) {
            s2.stop("Validation skipped");
          }
        } else if (chosenMethod.available) {
          // Show confirmation for available no-input methods (like OAuth)
          await note([
            pc.green(`✓ ${chosenMethod.name} ready`),
            "",
            ...(chosenMethod.setupInstructions || []),
          ].join("\n"), "Authentication");
        }
      }
    }
  } else {
    // Fallback: plugin doesn't expose auth methods, use legacy flow
    selectedAuthMethod = providerImpl?.getCredentialType?.() || "api-key";

    if (selectedAuthMethod === "api-key") {
      apiKey = await password({
        message: `Enter your ${providerInfo.name} API key`,
        validate: (value) => {
          if (!value.trim()) return "API key is required";
          if (value.length < 10) return "API key seems too short";
        },
      });
    }
  }

  // Get models from provider
  const models = providerImpl?.supportedModels || [];
  let model: string | undefined;

  if (models.length > 0 && !isQuickstart) {
    const modelOptions = models.map((m: string) => ({
      value: m,
      label: m,
    }));

    model = await select({
      message: "Choose a model",
      options: modelOptions,
      initialValue: providerImpl?.defaultModel || models[0],
    });
  } else if (models.length > 0) {
    model = providerImpl?.defaultModel || models[0];
  }

  await note([
    `Provider: ${providerInfo.name}`,
    model ? `Model: ${model}` : "",
    `Auth: ${selectedAuthMethod}`,
    "",
    pc.green("✓ Ready to use"),
  ].filter(Boolean).join("\n"), "Provider Configured");

  // Return config
  return {
    provider: {
      primary: providerId,
      authMethod: selectedAuthMethod,
      ...(apiKey ? { apiKey } : {}),
      ...(model ? { model } : {}),
    },
  };
};
