/**
 * Router Plugin UI Component for WOPR
 * 
 * Vanilla JS SolidJS component for managing message routing rules.
 */

const { createSignal, onMount } = window.Solid || Solid;

export default function RouterPluginUI(props) {
  const [routes, setRoutes] = createSignal([]);
  const [outgoingRoutes, setOutgoingRoutes] = createSignal([]);
  const [newSource, setNewSource] = createSignal("");
  const [newTargets, setNewTargets] = createSignal("");
  const [newChannelType, setNewChannelType] = createSignal("");

  onMount(async () => {
    const config = await props.api.getConfig();
    const routerConfig = config.plugins?.data?.router || {};
    setRoutes(routerConfig.routes || []);
    setOutgoingRoutes(routerConfig.outgoingRoutes || []);
  });

  const handleAddRoute = async () => {
    if (!newSource() || !newTargets()) return;
    
    const newRoute = {
      sourceSession: newSource(),
      targetSessions: newTargets().split(",").map(s => s.trim()).filter(Boolean),
      channelType: newChannelType() || undefined,
    };
    
    const updatedRoutes = [...routes(), newRoute];
    await props.saveConfig({
      routes: updatedRoutes,
      outgoingRoutes: outgoingRoutes(),
    });
    
    setRoutes(updatedRoutes);
    setNewSource("");
    setNewTargets("");
    setNewChannelType("");
  };

  const handleDeleteRoute = async (index) => {
    const updatedRoutes = routes().filter((_, i) => i !== index);
    await props.saveConfig({
      routes: updatedRoutes,
      outgoingRoutes: outgoingRoutes(),
    });
    setRoutes(updatedRoutes);
  };

  // Create DOM
  const container = document.createElement("div");
  container.className = "router-plugin-ui";
  
  // Header
  const header = document.createElement("div");
  header.className = "flex items-center justify-between mb-4";
  header.innerHTML = `
    <h3 class="text-lg font-semibold">Message Router</h3>
    <span class="px-2 py-1 rounded text-xs bg-blue-500/20 text-blue-400">
      ${routes().length} rules
    </span>
  `;
  container.appendChild(header);
  
  // Routes list
  const routesSection = document.createElement("div");
  routesSection.className = "mb-4";
  
  const updateRoutesList = () => {
    routesSection.innerHTML = "";
    
    if (routes().length === 0) {
      routesSection.innerHTML = `
        <div class="text-sm text-wopr-muted p-3 bg-wopr-panel rounded border border-wopr-border">
          No routing rules configured. Messages will not be forwarded.
        </div>
      `;
    } else {
      routes().forEach((route, index) => {
        const item = document.createElement("div");
        item.className = "p-3 bg-wopr-panel rounded border border-wopr-border flex items-center justify-between mb-2";
        item.innerHTML = `
          <div>
            <div class="font-medium">${route.sourceSession} → ${route.targetSessions.join(", ")}</div>
            ${route.channelType ? `<div class="text-sm text-wopr-muted">Channel: ${route.channelType}</div>` : ""}
          </div>
          <button class="delete-route px-3 py-1 bg-red-500/20 text-red-400 rounded text-sm hover:bg-red-500/30">
            Delete
          </button>
        `;
        item.querySelector(".delete-route").addEventListener("click", () => handleDeleteRoute(index));
        routesSection.appendChild(item);
      });
    }
  };
  
  // Initial render and reactive updates
  const unsubscribe = routes(updateRoutesList);
  updateRoutesList();
  
  container.appendChild(routesSection);
  
  // Add route form
  const formSection = document.createElement("div");
  formSection.className = "p-3 bg-wopr-panel rounded border border-wopr-border";
  formSection.innerHTML = `
    <h4 class="text-sm font-semibold text-wopr-muted uppercase mb-3">Add Route</h4>
    <div class="space-y-2">
      <input type="text" placeholder="Source session" class="source-input w-full bg-wopr-bg border border-wopr-border rounded px-3 py-2 text-sm" />
      <input type="text" placeholder="Target sessions (comma-separated)" class="targets-input w-full bg-wopr-bg border border-wopr-border rounded px-3 py-2 text-sm" />
      <input type="text" placeholder="Channel type (optional)" class="channel-input w-full bg-wopr-bg border border-wopr-border rounded px-3 py-2 text-sm" />
      <button class="add-btn w-full px-4 py-2 bg-wopr-accent text-wopr-bg rounded text-sm font-medium hover:bg-wopr-accent/90">
        Add Route
      </button>
    </div>
  `;
  
  // Bind inputs
  const sourceInput = formSection.querySelector(".source-input");
  const targetsInput = formSection.querySelector(".targets-input");
  const channelInput = formSection.querySelector(".channel-input");
  
  sourceInput.addEventListener("input", (e) => setNewSource(e.target.value));
  targetsInput.addEventListener("input", (e) => setNewTargets(e.target.value));
  channelInput.addEventListener("input", (e) => setNewChannelType(e.target.value));
  formSection.querySelector(".add-btn").addEventListener("click", handleAddRoute);
  
  container.appendChild(formSection);
  
  // Info section
  const infoSection = document.createElement("div");
  infoSection.className = "mt-4 p-3 bg-wopr-panel/50 rounded border border-wopr-border text-sm text-wopr-muted";
  infoSection.innerHTML = `
    <p class="mb-1"><strong>Incoming:</strong> Messages to source session are forwarded to targets.</p>
    <p><strong>Outgoing:</strong> Responses are sent back to originating channel.</p>
  `;
  container.appendChild(infoSection);
  
  return container;
}
