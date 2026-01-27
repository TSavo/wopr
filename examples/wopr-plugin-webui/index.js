import http from "http";
import { readFile } from "fs/promises";
import { extname, join, resolve } from "path";

const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 7331,
  baseUrl: "http://127.0.0.1:7437",
  auth: {
    mode: "none",
    token: "",
    password: "",
  },
};

const CONTENT_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

let server;
let ctx;
let configCache = DEFAULT_CONFIG;

function mergeConfig(base, overrides) {
  if (!overrides) return { ...base };
  return {
    ...base,
    ...overrides,
    auth: {
      ...base.auth,
      ...(overrides.auth || {}),
    },
  };
}

async function loadConfig() {
  const stored = await ctx.getConfig();
  configCache = mergeConfig(DEFAULT_CONFIG, stored);
  if (!stored || Object.keys(stored).length === 0) {
    await ctx.saveConfig(configCache);
  }
}

function getFilePath(urlPath) {
  const baseDir = resolve(join(ctx.getPluginDir(), "public"));
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  return join(baseDir, safePath);
}

async function handleRequest(req, res) {
  try {
    if (req.url === "/config") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(configCache));
      return;
    }

    const filePath = getFilePath(req.url || "/");
    const ext = extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
    const contents = await readFile(filePath);

    res.writeHead(200, { "Content-Type": contentType });
    res.end(contents);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

export default {
  name: "webui",
  version: "0.1.0",
  description: "Web UI for managing WOPR",

  async init(pluginContext) {
    ctx = pluginContext;
    await loadConfig();

    const { host, port } = configCache;
    server = http.createServer((req, res) => {
      handleRequest(req, res);
    });

    await new Promise((resolve) => {
      server.listen(port, host, () => resolve());
    });

    if (ctx.registerWebUiExtension) {
      ctx.registerWebUiExtension({
        id: "webui",
        title: "Web UI",
        url: `http://${host}:${port}`,
        description: "WOPR browser dashboard",
        category: "core",
      });
    }

    ctx.log.info(`Web UI available at http://${host}:${port}`);
  },

  async shutdown() {
    if (!server) return;
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  },
};
