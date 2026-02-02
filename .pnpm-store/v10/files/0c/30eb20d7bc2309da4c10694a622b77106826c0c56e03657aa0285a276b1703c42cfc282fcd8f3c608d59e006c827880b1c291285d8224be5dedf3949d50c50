import { Hono } from "hono";
import { UpgradeWebSocket } from "hono/ws";
import { WebSocket, WebSocketServer } from "ws";
import { Server } from "node:http";
import { Http2SecureServer, Http2Server } from "node:http2";

//#region src/index.d.ts
interface NodeWebSocket {
  upgradeWebSocket: UpgradeWebSocket<WebSocket, {
    onError: (err: unknown) => void;
  }>;
  injectWebSocket(server: Server | Http2Server | Http2SecureServer): void;
  wss: WebSocketServer;
}
interface NodeWebSocketInit {
  app: Hono<any, any, any>;
  baseUrl?: string | URL;
}
/**
* Create WebSockets for Node.js
* @param init Options
* @returns NodeWebSocket
*/
declare const createNodeWebSocket: (init: NodeWebSocketInit) => NodeWebSocket;
//#endregion
export { NodeWebSocket, NodeWebSocketInit, createNodeWebSocket };
//# sourceMappingURL=index.d.cts.map