/**
 * WOPR Router Plugin (example)
 *
 * Demonstrates middleware-driven routing between channels and sessions.
 */

let ctx = null;

function matchesRoute(route, input) {
  if (route.sourceSession && route.sourceSession !== input.session) return false;
  if (route.channelType && route.channelType !== input.channel?.type) return false;
  if (route.channelId && route.channelId !== input.channel?.id) return false;
  return true;
}

async function fanOutToSessions(route, input) {
  const targets = route.targetSessions || [];
  for (const target of targets) {
    if (!target || target === input.session) continue;
    await ctx.inject(target, input.message);
  }
}

async function fanOutToChannels(route, output) {
  const channels = ctx.getChannelsForSession(output.session);
  for (const adapter of channels) {
    if (route.channelType && adapter.channel.type !== route.channelType) continue;
    if (route.channelId && adapter.channel.id !== route.channelId) continue;
    await adapter.send(output.response);
  }
}

export default {
  name: "router",
  version: "0.1.0",
  description: "Example routing middleware between channels and sessions",

  async init(pluginContext) {
    ctx = pluginContext;

    ctx.registerMiddleware({
      name: "router",
      async onIncoming(input) {
        const config = ctx.getConfig();
        const routes = config.routes || [];
        for (const route of routes) {
          if (!matchesRoute(route, input)) continue;
          await fanOutToSessions(route, input);
        }
        return input.message;
      },
      async onOutgoing(output) {
        const config = ctx.getConfig();
        const routes = config.outgoingRoutes || [];
        for (const route of routes) {
          if (route.sourceSession && route.sourceSession !== output.session) continue;
          await fanOutToChannels(route, output);
        }
        return output.response;
      },
    });
  },
};
