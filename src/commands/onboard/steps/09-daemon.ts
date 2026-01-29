/**
 * Step 9: Gateway daemon setup
 */
import { text, select, confirm, note, spinner, pc } from "../prompts.js";
import { 
  DEFAULT_PORT, 
  randomToken, 
  isSystemdAvailable, 
  isLaunchdAvailable,
  waitForGateway,
} from "../helpers.js";
import type { OnboardContext, OnboardStep } from "../types.js";

export const daemonStep: OnboardStep = async (ctx: OnboardContext) => {
  if (ctx.opts.skipDaemon) {
    await note("Skipping daemon setup (--skip-daemon)", "Gateway");
    return {};
  }
  
  const isQuickstart = ctx.opts.flow === "quickstart";
  
  await note([
    "The WOPR Gateway provides:",
    "",
    "  • Web UI for chatting with your agent",
    "  • REST API for integrations",
    "  • WebSocket for real-time updates",
    "",
    pc.dim("Runs as a background service (daemon)."),
  ].join("\n"), "Gateway Daemon");
  
  // Determine port
  let port: number;
  if (ctx.nextConfig.gateway?.port) {
    port = ctx.nextConfig.gateway.port;
  } else if (isQuickstart) {
    port = DEFAULT_PORT;
  } else {
    const portStr = await text({
      message: "Gateway port",
      initialValue: String(DEFAULT_PORT),
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num < 1 || num > 65535) {
          return "Please enter a valid port number (1-65535)";
        }
      },
    });
    port = parseInt(portStr, 10);
  }
  
  // Determine bind address
  let bind: "loopback" | "lan" | "all";
  if (ctx.nextConfig.gateway?.bind) {
    bind = ctx.nextConfig.gateway.bind;
  } else if (isQuickstart) {
    bind = "loopback";
  } else {
    bind = await select<"loopback" | "lan" | "all">({
      message: "Gateway bind address",
      options: [
        { value: "loopback", label: "Loopback (127.0.0.1)", hint: "Only this machine" },
        { value: "lan", label: "LAN", hint: "Local network only" },
        { value: "all", label: "All interfaces (0.0.0.0)", hint: "Any machine can connect" },
      ],
      initialValue: "loopback",
    });
  }
  
  // Generate auth token
  let token: string;
  if (ctx.nextConfig.gateway?.auth?.token) {
    const useExisting = isQuickstart || await confirm({
      message: "Use existing auth token?",
      initialValue: true,
    });
    token = useExisting ? ctx.nextConfig.gateway.auth.token : randomToken();
  } else {
    token = randomToken();
  }
  
  // Ask about service installation
  const canInstallService = await isSystemdAvailable() || await isLaunchdAvailable();
  let installService = false;
  
  if (canInstallService) {
    if (isQuickstart) {
      installService = true;
    } else {
      installService = await confirm({
        message: "Install as system service (auto-start on boot)?",
        initialValue: true,
      });
    }
  }
  
  // Save gateway config
  const gatewayConfig = {
    port,
    bind,
    auth: {
      mode: "token" as const,
      token,
    },
  };
  
  await note([
    `Port: ${port}`,
    `Bind: ${bind === "loopback" ? "127.0.0.1 (localhost only)" : bind}`,
    `Auth: Token-based`,
    `Service: ${installService ? "Yes (auto-start)" : "Manual start"}`,
    "",
    pc.yellow("⚠️  Save this token!"),
    pc.cyan(`  ${token.substring(0, 20)}...`),
  ].join("\n"), "Gateway Configuration");
  
  // Install service if requested
  if (installService) {
    const s = await spinner();
    s.start("Installing system service...");
    
    // Import helper dynamically
    const { installSystemdService, installLaunchdService } = await import("../helpers.js");
    
    let result;
    if (await isSystemdAvailable()) {
      result = await installSystemdService(port, token, ctx.runtime);
    } else if (await isLaunchdAvailable()) {
      result = await installLaunchdService(port, token, ctx.runtime);
    }
    
    if (result?.ok) {
      s.stop("Service installed!");
      
      // Wait for gateway to be ready
      s.start("Waiting for gateway to start...");
      const probe = await waitForGateway(`http://127.0.0.1:${port}`, token, { deadlineMs: 20000 });
      
      if (probe.ok) {
        s.stop("Gateway is running!");
      } else {
        s.stop("Gateway not responding yet (may need a moment)");
      }
    } else {
      s.stop("Service installation failed");
      await note([
        `Error: ${result?.error}`,
        "",
        "You can start the daemon manually:",
        pc.cyan("  wopr daemon start"),
      ].join("\n"), "Service Installation");
    }
  } else {
    await note([
      "To start the daemon manually:",
      pc.cyan("  wopr daemon start"),
      "",
      "Or in the background:",
      pc.cyan("  wopr daemon start &"),
    ].join("\n"), "Manual Start");
  }
  
  return { gateway: gatewayConfig };
};
