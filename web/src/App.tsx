import { 
  Component, 
  createSignal, 
  onMount, 
  onCleanup, 
  For, 
  Show,
  lazy,
  Suspense,
  createResource,
  createMemo
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { api, type Session, type StreamEvent, type WebUiExtension, type UiComponentExtension, type PluginUiComponentProps } from "./lib/api";
import Settings from "./components/Settings";

// Cache for dynamically imported components
const componentCache = new Map<string, any>();

// Load a plugin component from its module URL
async function loadPluginComponent(moduleUrl: string) {
  if (componentCache.has(moduleUrl)) {
    return componentCache.get(moduleUrl);
  }
  
  try {
    const module = await import(/* @vite-ignore */ moduleUrl);
    const component = module.default;
    componentCache.set(moduleUrl, component);
    return component;
  } catch (err) {
    console.error(`Failed to load component from ${moduleUrl}:`, err);
    return null;
  }
}

// Component that renders a plugin UI component
const PluginComponent: Component<{
  componentDef: UiComponentExtension;
  api: PluginUiComponentProps['api'];
  currentSession?: string;
}> = (props) => {
  const [Component] = createResource(
    () => props.componentDef.moduleUrl,
    loadPluginComponent
  );

  const componentProps = createMemo(() => ({
    api: props.api,
    currentSession: props.currentSession,
    pluginConfig: {}, // TODO: fetch plugin config
    saveConfig: async () => {}, // TODO: implement
  }));

  return (
    <Suspense fallback={<div class="p-2 text-wopr-muted text-sm">Loading...</div>}>
      <Show when={Component()}>
        <div class="plugin-component border-t border-wopr-border/50 pt-3 mt-3">
          <div class="text-xs font-semibold text-wopr-muted uppercase mb-2">
            {props.componentDef.title}
          </div>
          <Dynamic component={Component()} {...componentProps()} />
        </div>
      </Show>
    </Suspense>
  );
};

const App: Component = () => {
  const [view, setView] = createSignal<"chat" | "settings">("chat");
  const [sessions, setSessions] = createSignal<Session[]>([]);
  const [selectedSession, setSelectedSession] = createSignal<string | null>(null);
  const [message, setMessage] = createSignal("");
  const [response, setResponse] = createSignal("");
  const [streaming, setStreaming] = createSignal(false);
  const [connected, setConnected] = createSignal(false);
  const [extensions, setExtensions] = createSignal<WebUiExtension[]>([]);
  const [uiComponents, setUiComponents] = createSignal<UiComponentExtension[]>([]);

  let ws: WebSocket | null = null;

  // API object passed to plugin components
  const pluginApi: PluginUiComponentProps['api'] = {
    getSessions: api.getSessions,
    inject: api.inject,
    getConfig: api.getConfig,
    setConfigValue: api.setConfigValue,
  };

  // Group components by slot
  const sidebarComponents = createMemo(() => 
    uiComponents().filter(c => c.slot === 'sidebar')
  );
  const settingsComponents = createMemo(() => 
    uiComponents().filter(c => c.slot === 'settings')
  );
  const statusbarComponents = createMemo(() => 
    uiComponents().filter(c => c.slot === 'statusbar')
  );
  const chatHeaderComponents = createMemo(() => 
    uiComponents().filter(c => c.slot === 'chat-header')
  );
  const chatFooterComponents = createMemo(() => 
    uiComponents().filter(c => c.slot === 'chat-footer')
  );

  onMount(async () => {
    // Load sessions
    const data = await api.getSessions();
    setSessions(data.sessions);

    // Load plugin extensions
    try {
      const extData = await api.getWebUiExtensions();
      setExtensions(extData.extensions);
    } catch (err) {
      console.error("Failed to load extensions:", err);
    }

    // Load UI components
    try {
      const compData = await api.getUiComponents();
      setUiComponents(compData.components);
    } catch (err) {
      console.error("Failed to load UI components:", err);
    }

    // Connect WebSocket
    connectWebSocket();
  });

  onCleanup(() => {
    ws?.close();
  });

  function connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setConnected(true);
      // Subscribe to all sessions
      ws?.send(JSON.stringify({ type: "subscribe", sessions: ["*"] }));
    };

    ws.onclose = () => {
      setConnected(false);
      // Reconnect after delay
      setTimeout(connectWebSocket, 3000);
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as StreamEvent;

      if (data.type === "stream" && data.session === selectedSession()) {
        if (data.message.type === "text") {
          setResponse((prev) => prev + data.message.content);
        } else if (data.message.type === "complete") {
          setStreaming(false);
        }
      }
    };
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const session = selectedSession();
    const msg = message();

    if (!session || !msg.trim()) return;

    setResponse("");
    setStreaming(true);
    setMessage("");

    try {
      await api.inject(session, msg);
    } catch (err) {
      console.error("Inject failed:", err);
      setStreaming(false);
    }
  }

  async function createSession() {
    const name = prompt("Session name:");
    if (!name) return;

    await api.createSession(name);
    const data = await api.getSessions();
    setSessions(data.sessions);
    setSelectedSession(name);
  }

  return (
    <div class="min-h-screen flex flex-col">
      {/* Header */}
      <header class="bg-wopr-panel border-b border-wopr-border px-4 py-3 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h1 class="text-xl font-bold text-wopr-accent">WOPR</h1>
          <span class="text-wopr-muted text-sm">v0.0.1</span>
        </div>
        <div class="flex items-center gap-4">
          <div class="flex gap-2">
            <button
              onClick={() => setView("chat")}
              class={`px-3 py-1 rounded text-sm ${view() === "chat" ? "bg-wopr-accent text-wopr-bg" : "text-wopr-muted hover:text-wopr-text"}`}
            >
              Chat
            </button>
            <button
              onClick={() => setView("settings")}
              class={`px-3 py-1 rounded text-sm ${view() === "settings" ? "bg-wopr-accent text-wopr-bg" : "text-wopr-muted hover:text-wopr-text"}`}
            >
              Settings
            </button>
          </div>
          
          {/* Status bar plugin components */}
          <For each={statusbarComponents()}>
            {(comp) => (
              <PluginComponent 
                componentDef={comp} 
                api={pluginApi}
                currentSession={selectedSession() || undefined}
              />
            )}
          </For>
          
          <div class="flex items-center gap-2">
            <span class={`w-2 h-2 rounded-full ${connected() ? "bg-green-500" : "bg-red-500"}`} />
            <span class="text-sm text-wopr-muted">
              {connected() ? "Connected" : "Disconnected"}
            </span>
          </div>
        </div>
      </header>

      <div class="flex flex-1">
        <Show when={view() === "chat"}>
          {/* Sidebar */}
          <aside class="w-64 bg-wopr-panel border-r border-wopr-border p-4">
            <div class="flex items-center justify-between mb-4">
              <h2 class="text-sm font-semibold text-wopr-muted uppercase">Sessions</h2>
              <button
                onClick={createSession}
                class="text-wopr-accent hover:text-wopr-accent/80 text-sm"
              >
                + New
              </button>
            </div>

            <ul class="space-y-1">
              <For each={sessions()}>
                {(session) => (
                  <li>
                    <button
                      onClick={() => {
                        setSelectedSession(session.name);
                        setResponse("");
                      }}
                      class={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                        selectedSession() === session.name
                          ? "bg-wopr-accent/20 text-wopr-accent"
                          : "hover:bg-wopr-border text-wopr-text"
                      }`}
                    >
                      {session.name}
                    </button>
                  </li>
                )}
              </For>
            </ul>

            {/* Sidebar plugin components */}
            <For each={sidebarComponents()}>
              {(comp) => (
                <PluginComponent 
                  componentDef={comp} 
                  api={pluginApi}
                  currentSession={selectedSession() || undefined}
                />
              )}
            </For>

            {/* Plugin Extensions (links) */}
            <Show when={extensions().length > 0}>
              <div class="mt-6">
                <h2 class="text-sm font-semibold text-wopr-muted uppercase mb-3">Extensions</h2>
                <ul class="space-y-1">
                  <For each={extensions()}>
                    {(ext) => (
                      <li>
                        <a
                          href={ext.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="w-full text-left px-3 py-2 rounded text-sm hover:bg-wopr-border text-wopr-text flex items-center gap-2"
                          title={ext.description}
                        >
                          <span>{ext.title}</span>
                          <svg class="w-3 h-3 text-wopr-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>
          </aside>
        </Show>

        {/* Main content */}
        <main class="flex-1 flex flex-col">
          <Show when={view() === "settings"}>
            <Settings />
            
            {/* Settings plugin components */}
            <For each={settingsComponents()}>
              {(comp) => (
                <div class="p-4 border-t border-wopr-border">
                  <PluginComponent 
                    componentDef={comp} 
                    api={pluginApi}
                    currentSession={selectedSession() || undefined}
                  />
                </div>
              )}
            </For>
          </Show>

          <Show when={view() === "chat"}>
            <Show
              when={selectedSession()}
              fallback={
                <div class="flex-1 flex items-center justify-center text-wopr-muted">
                  Select or create a session to begin
                </div>
              }
            >
              {/* Chat header plugin components */}
              <For each={chatHeaderComponents()}>
                {(comp) => (
                  <div class="px-4 py-2 border-b border-wopr-border bg-wopr-panel/50">
                    <PluginComponent 
                      componentDef={comp} 
                      api={pluginApi}
                      currentSession={selectedSession() || undefined}
                    />
                  </div>
                )}
              </For>
              
              {/* Response area */}
              <div class="flex-1 p-6 overflow-auto">
                <div class="max-w-4xl mx-auto">
                  <Show when={response()}>
                    <div class="bg-wopr-panel rounded-lg p-4 border border-wopr-border">
                      <pre class={`whitespace-pre-wrap ${streaming() ? "cursor-blink" : ""}`}>
                        {response()}
                      </pre>
                    </div>
                  </Show>
                </div>
              </div>

              {/* Input area */}
              <div class="border-t border-wopr-border p-4">
                {/* Chat footer plugin components */}
                <For each={chatFooterComponents()}>
                  {(comp) => (
                    <div class="mb-3">
                      <PluginComponent 
                        componentDef={comp} 
                        api={pluginApi}
                        currentSession={selectedSession() || undefined}
                      />
                    </div>
                  )}
                </For>
                
                <form onSubmit={handleSubmit} class="max-w-4xl mx-auto flex gap-3">
                  <textarea
                    value={message()}
                    onInput={(e) => setMessage(e.currentTarget.value)}
                    placeholder={`Inject into ${selectedSession()}...`}
                    class="flex-1 bg-wopr-panel border border-wopr-border rounded-lg px-4 py-3 resize-none focus:outline-none focus:border-wopr-accent"
                    rows={2}
                    disabled={streaming()}
                  />
                  <button
                    type="submit"
                    disabled={streaming() || !message().trim()}
                    class="px-6 py-3 bg-wopr-accent text-wopr-bg rounded-lg font-semibold hover:bg-wopr-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {streaming() ? "..." : "Send"}
                  </button>
                </form>
              </div>
            </Show>
          </Show>
        </main>
      </div>
    </div>
  );
};

export default App;
