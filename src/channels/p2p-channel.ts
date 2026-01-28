import type Hyperswarm from "hyperswarm";
import type { ChannelRef } from "../types.js";
import { createP2PListener, sendP2PInject, type SendResult } from "../p2p.js";

export function p2pChannelRef(peerKey: string): ChannelRef {
  return { type: "p2p", id: peerKey };
}

export function startP2PChannel(
  onInject: (session: string, message: string, peerKey?: string, channel?: ChannelRef) => Promise<void>,
  onLog: (msg: string) => void
): Hyperswarm | null {
  return createP2PListener(async (session, message, peerKey) => {
    const channel = peerKey ? p2pChannelRef(peerKey) : undefined;
    await onInject(session, message, peerKey, channel);
  }, onLog);
}

export async function sendP2PChannelMessage(
  peerIdOrName: string,
  session: string,
  message: string
): Promise<SendResult> {
  return sendP2PInject(peerIdOrName, session, message);
}
