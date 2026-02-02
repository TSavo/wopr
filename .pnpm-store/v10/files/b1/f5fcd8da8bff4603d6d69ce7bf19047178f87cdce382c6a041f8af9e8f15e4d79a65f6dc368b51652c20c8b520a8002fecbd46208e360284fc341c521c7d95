import { defineWebSocketHelper } from "hono/ws";
import { WebSocketServer } from "ws";
import { STATUS_CODES } from "node:http";

//#region src/events.ts
/**
* @link https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent
*/
const CloseEvent = globalThis.CloseEvent ?? class extends Event {
	#eventInitDict;
	constructor(type, eventInitDict = {}) {
		super(type, eventInitDict);
		this.#eventInitDict = eventInitDict;
	}
	get wasClean() {
		return this.#eventInitDict.wasClean ?? false;
	}
	get code() {
		return this.#eventInitDict.code ?? 0;
	}
	get reason() {
		return this.#eventInitDict.reason ?? "";
	}
};

//#endregion
//#region src/index.ts
const generateConnectionSymbol = () => Symbol("connection");
/** @example `c.env[CONNECTION_SYMBOL_KEY]` */
const CONNECTION_SYMBOL_KEY = Symbol("CONNECTION_SYMBOL_KEY");
/**
* Create WebSockets for Node.js
* @param init Options
* @returns NodeWebSocket
*/
const createNodeWebSocket = (init) => {
	const wss = new WebSocketServer({ noServer: true });
	const waiterMap = /* @__PURE__ */ new Map();
	wss.on("connection", (ws, request) => {
		const waiter = waiterMap.get(request);
		if (waiter) {
			waiter.resolve(ws);
			waiterMap.delete(request);
		}
	});
	const nodeUpgradeWebSocket = (request, connectionSymbol) => {
		return new Promise((resolve) => {
			waiterMap.set(request, {
				resolve,
				connectionSymbol
			});
		});
	};
	return {
		wss,
		injectWebSocket(server) {
			server.on("upgrade", async (request, socket, head) => {
				const url = new URL(request.url ?? "/", init.baseUrl ?? "http://localhost");
				const headers = new Headers();
				for (const key in request.headers) {
					const value = request.headers[key];
					if (!value) continue;
					headers.append(key, Array.isArray(value) ? value[0] : value);
				}
				const env = {
					incoming: request,
					outgoing: void 0
				};
				const response = await init.app.request(url, { headers }, env);
				const waiter = waiterMap.get(request);
				if (!waiter || waiter.connectionSymbol !== env[CONNECTION_SYMBOL_KEY]) {
					socket.end(`HTTP/1.1 ${response.status.toString()} ${STATUS_CODES[response.status] ?? ""}\r\nConnection: close\r
Content-Length: 0\r
\r
`);
					waiterMap.delete(request);
					return;
				}
				wss.handleUpgrade(request, socket, head, (ws) => {
					wss.emit("connection", ws, request);
				});
			});
		},
		upgradeWebSocket: defineWebSocketHelper(async (c, events, options) => {
			if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return;
			const connectionSymbol = generateConnectionSymbol();
			c.env[CONNECTION_SYMBOL_KEY] = connectionSymbol;
			(async () => {
				const ws = await nodeUpgradeWebSocket(c.env.incoming, connectionSymbol);
				const messagesReceivedInStarting = [];
				const bufferMessage = (data, isBinary) => {
					messagesReceivedInStarting.push([data, isBinary]);
				};
				ws.on("message", bufferMessage);
				const ctx = {
					binaryType: "arraybuffer",
					close(code, reason) {
						ws.close(code, reason);
					},
					protocol: ws.protocol,
					raw: ws,
					get readyState() {
						return ws.readyState;
					},
					send(source, opts) {
						ws.send(source, { compress: opts?.compress });
					},
					url: new URL(c.req.url)
				};
				try {
					events?.onOpen?.(new Event("open"), ctx);
				} catch (e) {
					(options?.onError ?? console.error)(e);
				}
				const handleMessage = (data, isBinary) => {
					const datas = Array.isArray(data) ? data : [data];
					for (const data$1 of datas) try {
						events?.onMessage?.(new MessageEvent("message", { data: isBinary ? data$1 instanceof ArrayBuffer ? data$1 : data$1.buffer.slice(data$1.byteOffset, data$1.byteOffset + data$1.byteLength) : data$1.toString("utf-8") }), ctx);
					} catch (e) {
						(options?.onError ?? console.error)(e);
					}
				};
				ws.off("message", bufferMessage);
				for (const message of messagesReceivedInStarting) handleMessage(...message);
				ws.on("message", (data, isBinary) => {
					handleMessage(data, isBinary);
				});
				ws.on("close", (code, reason) => {
					try {
						events?.onClose?.(new CloseEvent("close", {
							code,
							reason: reason.toString()
						}), ctx);
					} catch (e) {
						(options?.onError ?? console.error)(e);
					}
				});
				ws.on("error", (error) => {
					try {
						events?.onError?.(new ErrorEvent("error", { error }), ctx);
					} catch (e) {
						(options?.onError ?? console.error)(e);
					}
				});
			})();
			return new Response();
		})
	};
};

//#endregion
export { createNodeWebSocket };
//# sourceMappingURL=index.js.map