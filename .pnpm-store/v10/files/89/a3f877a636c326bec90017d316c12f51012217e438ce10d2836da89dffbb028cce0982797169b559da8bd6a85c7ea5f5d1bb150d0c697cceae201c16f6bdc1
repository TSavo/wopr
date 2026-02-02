//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let hono_ws = require("hono/ws");
hono_ws = __toESM(hono_ws);
let ws = require("ws");
ws = __toESM(ws);
let node_http = require("node:http");
node_http = __toESM(node_http);

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
	const wss = new ws.WebSocketServer({ noServer: true });
	const waiterMap = /* @__PURE__ */ new Map();
	wss.on("connection", (ws$1, request) => {
		const waiter = waiterMap.get(request);
		if (waiter) {
			waiter.resolve(ws$1);
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
					socket.end(`HTTP/1.1 ${response.status.toString()} ${node_http.STATUS_CODES[response.status] ?? ""}\r\nConnection: close\r
Content-Length: 0\r
\r
`);
					waiterMap.delete(request);
					return;
				}
				wss.handleUpgrade(request, socket, head, (ws$1) => {
					wss.emit("connection", ws$1, request);
				});
			});
		},
		upgradeWebSocket: (0, hono_ws.defineWebSocketHelper)(async (c, events, options) => {
			if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return;
			const connectionSymbol = generateConnectionSymbol();
			c.env[CONNECTION_SYMBOL_KEY] = connectionSymbol;
			(async () => {
				const ws$1 = await nodeUpgradeWebSocket(c.env.incoming, connectionSymbol);
				const messagesReceivedInStarting = [];
				const bufferMessage = (data, isBinary) => {
					messagesReceivedInStarting.push([data, isBinary]);
				};
				ws$1.on("message", bufferMessage);
				const ctx = {
					binaryType: "arraybuffer",
					close(code, reason) {
						ws$1.close(code, reason);
					},
					protocol: ws$1.protocol,
					raw: ws$1,
					get readyState() {
						return ws$1.readyState;
					},
					send(source, opts) {
						ws$1.send(source, { compress: opts?.compress });
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
				ws$1.off("message", bufferMessage);
				for (const message of messagesReceivedInStarting) handleMessage(...message);
				ws$1.on("message", (data, isBinary) => {
					handleMessage(data, isBinary);
				});
				ws$1.on("close", (code, reason) => {
					try {
						events?.onClose?.(new CloseEvent("close", {
							code,
							reason: reason.toString()
						}), ctx);
					} catch (e) {
						(options?.onError ?? console.error)(e);
					}
				});
				ws$1.on("error", (error) => {
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
exports.createNodeWebSocket = createNodeWebSocket;