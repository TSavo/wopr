/**
 * Step 7: Channel setup
 */
import { multiselect, note, spinner, confirm, pc } from "../prompts.js";
import { AVAILABLE_CHANNELS } from "../types.js";
import { installPlugin } from "../../../plugins.js";
import type { OnboardContext, OnboardStep } from "../types.js";

export const channelsStep: OnboardStep = async (ctx: OnboardContext) => {
  if (ctx.opts.skipChannels) {
    await note("Skipping channel setup (--skip-channels)", "Channels");
    return {};
  }
  
  const isQuickstart = ctx.opts.flow === "quickstart";
  
  // Show available channels
  await note([
    "Channels let WOPR receive and send messages.",
    "",
    "Available:",
    ...AVAILABLE_CHANNELS.map(c => `  • ${c.name}: ${c.description}`),
    "",
    pc.dim("You can add more channels later with: wopr channels add"),
  ].join("\n"), "Channels");
  
  // Select channels to install
  let selectedChannels: string[];
  
  if (isQuickstart) {
    // In QuickStart, ask about popular channels
    const wantDiscord = await confirm({
      message: "Set up Discord integration?",
      initialValue: false,
    });
    const wantSlack = await confirm({
      message: "Set up Slack integration?",
      initialValue: false,
    });
    // Only ask about iMessage on macOS
    let wantIMessage = false;
    if (process.platform === "darwin") {
      wantIMessage = await confirm({
        message: "Set up iMessage integration (macOS only)?",
        initialValue: false,
      });
    }
    selectedChannels = [];
    if (wantDiscord) selectedChannels.push("discord");
    if (wantSlack) selectedChannels.push("slack");
    if (wantIMessage) selectedChannels.push("imessage");
  } else {
    // Advanced: full multiselect
    const options = AVAILABLE_CHANNELS.map(c => ({
      value: c.id,
      label: c.name,
      hint: c.description,
    }));
    
    selectedChannels = await multiselect({
      message: "Select channels to set up",
      options,
      required: false,
    });
  }
  
  if (selectedChannels.length === 0) {
    await note([
      "No channels configured.",
      "",
      "You can add channels later:",
      pc.cyan("  wopr channels add discord"),
    ].join("\n"), "Channels");
    return { channels: [] };
  }
  
  // Install plugins for selected channels
  const s = await spinner();
  const installed: string[] = [];
  const errors: string[] = [];
  
  for (const channelId of selectedChannels) {
    const channelInfo = AVAILABLE_CHANNELS.find(c => c.id === channelId);
    if (!channelInfo) continue;
    
    // Skip if already in config
    if (ctx.nextConfig.channels?.includes(channelId)) {
      installed.push(channelId);
      continue;
    }
    
    if (channelInfo.npm) {
      s.start(`Installing ${channelInfo.name} plugin...`);
      try {
        await installPlugin(channelInfo.npm);
        installed.push(channelId);
        s.stop(`${channelInfo.name} plugin installed!`);
      } catch (err: any) {
        s.stop(`${channelInfo.name} plugin failed`);
        errors.push(`${channelInfo.name}: ${err.message}`);
      }
    } else {
      // Built-in (like P2P)
      installed.push(channelId);
    }
  }
  
  if (errors.length > 0) {
    await note([
      "Some channels failed to install:",
      ...errors.map(e => `  • ${e}`),
      "",
      "You can retry later with:",
      pc.cyan("  wopr channels add <channel>"),
    ].join("\n"), "Channel Issues");
  }
  
  if (installed.includes("discord")) {
    await note([
      "Discord plugin installed!",
      "",
      "Next steps:",
      "  1. Create a Discord bot at https://discord.com/developers",
      "  2. Get your bot token",
      "  3. Configure with: wopr configure --plugin discord",
      "",
      pc.blue("Docs: https://github.com/TSavo/wopr-plugin-discord"),
    ].join("\n"), "Discord Setup");
  }
  
  if (installed.includes("slack")) {
    await note([
      "Slack plugin installed!",
      "",
      "Next steps:",
      "  1. Create a Slack app at https://api.slack.com/apps",
      "  2. Enable Socket Mode",
      "  3. Generate App-Level Token (xapp-...)",
      "  4. Install to workspace, copy Bot Token (xoxb-...)",
      "  5. Configure with: wopr configure --plugin slack",
      "",
      pc.blue("Docs: https://github.com/TSavo/wopr-plugin-slack"),
    ].join("\n"), "Slack Setup");
  }
  
  if (installed.includes("imessage")) {
    await note([
      "iMessage plugin installed!",
      "",
      pc.yellow("⚠️  macOS only - requires Full Disk Access"),
      "",
      "Next steps:",
      "  1. Install imsg CLI: brew install steipete/tap/imsg",
      "  2. Grant Full Disk Access to WOPR",
      "  3. Configure with: wopr configure --plugin imessage",
      "  4. Approve Automation permission when prompted",
      "",
      "Test with: imsg chats --limit 5",
      "",
      pc.blue("Docs: https://github.com/TSavo/wopr-plugin-imessage"),
    ].join("\n"), "iMessage Setup");
  }
  
  return { channels: installed };
};
