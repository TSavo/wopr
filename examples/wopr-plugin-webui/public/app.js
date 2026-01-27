const state = {
  config: null,
};

const selectors = {
  daemonInfo: document.getElementById("daemon-info"),
  refreshAll: document.getElementById("refresh-all"),
  sessionsList: document.getElementById("sessions-list"),
  peersList: document.getElementById("peers-list"),
  accessList: document.getElementById("access-list"),
  invitesList: document.getElementById("invites-list"),
  pluginsList: document.getElementById("plugins-list"),
  skillsList: document.getElementById("skills-list"),
  extensionsList: document.getElementById("extensions-list"),
  extensionsNavList: document.getElementById("extensions-nav-list"),
  configJson: document.getElementById("config-json"),
  inviteToken: document.getElementById("invite-token"),
  pluginConfigSelect: document.getElementById("plugin-config-select"),
  pluginConfigJson: document.getElementById("plugin-config-json"),
  chatSessionSelect: document.getElementById("chat-session-select"),
  chatLimit: document.getElementById("chat-limit"),
  chatMessage: document.getElementById("chat-message"),
  chatLog: document.getElementById("chat-log"),
};

function headers() {
  const auth = state.config?.auth || { mode: "none" };
  if (auth.mode === "token" && auth.token) {
    return { Authorization: `Bearer ${auth.token}` };
  }
  if (auth.mode === "password" && auth.password) {
    return { "X-WOPR-PASSWORD": auth.password };
  }
  return {};
}

async function fetchJson(path, options = {}) {
  const res = await fetch(`${state.config.baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...headers(),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function listItem(content) {
  const li = document.createElement("li");
  li.textContent = content;
  return li;
}

function linkItem(label, url) {
  const li = document.createElement("li");
  const link = document.createElement("a");
  link.href = url;
  link.textContent = label;
  link.target = "_blank";
  link.rel = "noreferrer";
  li.appendChild(link);
  return li;
}

function linkItemLocal(label, url) {
  const li = document.createElement("li");
  const link = document.createElement("a");
  link.href = url;
  link.textContent = label;
  link.addEventListener("click", () => setActiveSection(url.replace("#", "")));
  li.appendChild(link);
  return li;
}

function chatEntry(entry) {
  const container = document.createElement("div");
  container.classList.add("chat-entry");
  const meta = document.createElement("div");
  meta.classList.add("chat-meta");
  const ts = new Date(entry.ts).toLocaleString();
  meta.textContent = `${entry.from} · ${entry.type} · ${ts}`;
  const content = document.createElement("div");
  content.classList.add("chat-content");
  content.textContent = entry.content;
  container.appendChild(meta);
  container.appendChild(content);
  return container;
}

function setActiveSection(sectionId) {
  const sections = document.querySelectorAll("[data-section]");
  sections.forEach((section) => {
    if (section.id === sectionId) {
      section.classList.remove("hidden");
    } else {
      section.classList.add("hidden");
    }
  });
}

function syncSectionFromHash() {
  const hash = window.location.hash.replace("#", "");
  const fallback = hash && document.getElementById(hash) ? hash : "chat";
  setActiveSection(fallback);
}

async function loadConfig() {
  const res = await fetch("/config");
  state.config = await res.json();
  selectors.daemonInfo.textContent = `Daemon: ${state.config.baseUrl} | Auth: ${state.config.auth.mode}`;
}

async function loadSessions() {
  const data = await fetchJson("/sessions");
  selectors.sessionsList.innerHTML = "";
  selectors.chatSessionSelect.innerHTML = "";
  data.sessions.forEach((session) => {
    selectors.sessionsList.appendChild(
      listItem(`${session.name}${session.hasContext ? " (context)" : ""}`)
    );
    const option = document.createElement("option");
    option.value = session.name;
    option.textContent = session.name;
    selectors.chatSessionSelect.appendChild(option);
  });
}

async function loadPeers() {
  const data = await fetchJson("/peers");
  selectors.peersList.innerHTML = "";
  data.peers.forEach((peer) => {
    selectors.peersList.appendChild(
      listItem(`${peer.name || peer.id} | Sessions: ${peer.sessions.join(", ")}`)
    );
  });
}

async function loadAccess() {
  const data = await fetchJson("/peers/access");
  selectors.accessList.innerHTML = "";
  data.grants.forEach((grant) => {
    selectors.accessList.appendChild(
      listItem(`${grant.peerName || grant.peerKey} | Sessions: ${grant.sessions.join(", ")}`)
    );
  });
}

async function loadInvites() {
  const data = await fetchJson("/peers/invites");
  selectors.invitesList.innerHTML = "";
  data.invites.forEach((invite) => {
    const status = invite.claimedAt ? "claimed" : "pending";
    selectors.invitesList.appendChild(
      listItem(`${invite.peerKey} | ${status} | Sessions: ${invite.sessions.join(", ")}`)
    );
  });
}

async function loadPlugins() {
  const data = await fetchJson("/plugins");
  selectors.pluginsList.innerHTML = "";
  selectors.pluginConfigSelect.innerHTML = "";
  data.plugins.forEach((plugin) => {
    selectors.pluginsList.appendChild(
      listItem(`${plugin.name} v${plugin.version} (${plugin.enabled ? "enabled" : "disabled"})`)
    );
    const option = document.createElement("option");
    option.value = plugin.name;
    option.textContent = plugin.name;
    selectors.pluginConfigSelect.appendChild(option);
  });
}

async function loadSkills() {
  const data = await fetchJson("/skills");
  selectors.skillsList.innerHTML = "";
  data.skills.forEach((skill) => {
    selectors.skillsList.appendChild(listItem(`${skill.name}`));
  });
}

async function loadExtensions() {
  const data = await fetchJson("/plugins/ui");
  selectors.extensionsList.innerHTML = "";
  selectors.extensionsNavList.innerHTML = "";
  data.extensions.forEach((extension) => {
    selectors.extensionsList.appendChild(
      linkItem(extension.title, extension.url)
    );
    selectors.extensionsNavList.appendChild(
      linkItemLocal(extension.title, extension.url)
    );
  });
}

async function loadConfigSnapshot() {
  const data = await fetchJson("/config");
  selectors.configJson.textContent = JSON.stringify(data, null, 2);
}

async function loadPluginConfig(pluginName) {
  const config = await fetchJson("/config");
  const pluginConfig = config?.plugins?.data?.[pluginName] ?? {};
  selectors.pluginConfigJson.value = JSON.stringify(pluginConfig, null, 2);
}

async function loadChatHistory(sessionName, limit) {
  const data = await fetchJson(`/sessions/${encodeURIComponent(sessionName)}/conversation?limit=${limit}`);
  selectors.chatLog.innerHTML = "";
  data.entries.forEach((entry) => {
    selectors.chatLog.appendChild(chatEntry(entry));
  });
  selectors.chatLog.scrollTop = selectors.chatLog.scrollHeight;
}

async function refreshAll() {
  try {
    await loadSessions();
    await loadPeers();
    await loadAccess();
    await loadInvites();
    await loadPlugins();
    await loadSkills();
    await loadExtensions();
    await loadConfigSnapshot();
  } catch (err) {
    console.error(err);
    alert(err.message);
  }
}

function parseSessions(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function attachHandlers() {
  document.getElementById("session-create").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.name.value.trim();
    const context = form.context.value.trim();
    await fetchJson("/sessions", {
      method: "POST",
      body: JSON.stringify({ name, context: context || undefined }),
    });
    form.reset();
    await loadSessions();
  });

  document.getElementById("session-inject").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const session = form.session.value.trim();
    const message = form.message.value.trim();
    await fetchJson(`/sessions/${encodeURIComponent(session)}/inject`, {
      method: "POST",
      body: JSON.stringify({ message, from: "webui" }),
    });
    form.reset();
  });

  document.getElementById("chat-session").addEventListener("submit", async (event) => {
    event.preventDefault();
    const session = selectors.chatSessionSelect.value;
    if (!session) return;
    const limit = parseInt(selectors.chatLimit.value, 10) || 50;
    await loadChatHistory(session, limit);
  });

  document.getElementById("chat-send").addEventListener("submit", async (event) => {
    event.preventDefault();
    const session = selectors.chatSessionSelect.value;
    const message = selectors.chatMessage.value.trim();
    if (!session || !message) return;
    await fetchJson(`/sessions/${encodeURIComponent(session)}/inject`, {
      method: "POST",
      body: JSON.stringify({ message, from: "webui" }),
    });
    selectors.chatMessage.value = "";
    const limit = parseInt(selectors.chatLimit.value, 10) || 50;
    await loadChatHistory(session, limit);
  });

  document.getElementById("invite-create").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const peerPubkey = form.peerPubkey.value.trim();
    const sessions = parseSessions(form.sessions.value) || ["*"];
    const result = await fetchJson("/peers/invite", {
      method: "POST",
      body: JSON.stringify({ peerPubkey, sessions }),
    });
    selectors.inviteToken.textContent = `Invite token: ${result.token}`;
    form.reset();
    await loadInvites();
  });

  document.getElementById("invite-claim").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const token = form.token.value.trim();
    await fetchJson("/peers/claim", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    form.reset();
    await loadPeers();
  });

  document.getElementById("access-update").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const peer = form.peer.value.trim();
    const sessions = parseSessions(form.sessions.value);
    await fetchJson(`/peers/${encodeURIComponent(peer)}/access`, {
      method: "PUT",
      body: JSON.stringify({ sessions }),
    });
    form.reset();
    await loadAccess();
  });

  document.getElementById("peer-update").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const peer = form.peer.value.trim();
    const sessions = parseSessions(form.sessions.value);
    await fetchJson(`/peers/${encodeURIComponent(peer)}`, {
      method: "PUT",
      body: JSON.stringify({ sessions }),
    });
    form.reset();
    await loadPeers();
  });

  document.getElementById("plugin-install").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const source = form.source.value.trim();
    await fetchJson("/plugins", {
      method: "POST",
      body: JSON.stringify({ source }),
    });
    form.reset();
    await loadPlugins();
  });

  document.getElementById("skill-install").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const source = form.source.value.trim();
    await fetchJson("/skills/install", {
      method: "POST",
      body: JSON.stringify({ source }),
    });
    form.reset();
    await loadSkills();
  });

  document.getElementById("plugin-config-load").addEventListener("submit", async (event) => {
    event.preventDefault();
    const pluginName = selectors.pluginConfigSelect.value;
    if (!pluginName) return;
    await loadPluginConfig(pluginName);
  });

  document.getElementById("plugin-config-save").addEventListener("submit", async (event) => {
    event.preventDefault();
    const pluginName = selectors.pluginConfigSelect.value;
    if (!pluginName) return;
    let payload;
    try {
      payload = JSON.parse(selectors.pluginConfigJson.value || "{}");
    } catch (err) {
      alert(`Invalid JSON: ${err.message}`);
      return;
    }
    await fetchJson(`/config/plugins.data.${encodeURIComponent(pluginName)}`, {
      method: "PUT",
      body: JSON.stringify({ value: payload }),
    });
    await loadConfigSnapshot();
  });

  selectors.refreshAll.addEventListener("click", refreshAll);
  window.addEventListener("hashchange", syncSectionFromHash);
}

async function init() {
  await loadConfig();
  attachHandlers();
  await refreshAll();
  syncSectionFromHash();
  if (selectors.chatSessionSelect.value) {
    await loadChatHistory(selectors.chatSessionSelect.value, parseInt(selectors.chatLimit.value, 10) || 50);
  }
}

init();
