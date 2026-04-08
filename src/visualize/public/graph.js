// src/visualize/public/graph.js
//
// Sections:
//   STATE   — viewState + loadedSet
//   API     — fetch wrappers
//   MERGE   — server response → loadedSet
//   RENDER  — vis.Network init + applyViewFilters
//   EVENTS  — DOM/network event handlers
//   BOOT    — entry point

// === STATE ===
const GROUP_COLORS = {
  Repository: { background: "#1f6feb", border: "#388bfd" },
  File: { background: "#1a7f37", border: "#2ea043" },
  Class: { background: "#8957e5", border: "#a371f7" },
  Function: { background: "#da3633", border: "#f85149" },
};

const viewState = {
  search: "",
  visibleNodeTypes: new Set(["Repository", "File", "Class", "Function"]),
  visibleEdgeTypes: new Set([
    "CONTAINS_FILE",
    "CONTAINS",
    "HAS_METHOD",
    "IMPORTS",
    "CALLS",
  ]),
};

const loadedSet = {
  nodes: new vis.DataSet(),
  edges: new vis.DataSet(),
};

let network = null;
let edgeIdCounter = 0;

// === API ===
function parseUrlFilters() {
  const p = new URLSearchParams(window.location.search);
  const out = {};
  for (const k of ["repo", "file", "function"]) {
    const v = p.get(k);
    if (v) out[k] = v;
  }
  return out;
}

async function fetchGraph(filters) {
  const qs = new URLSearchParams(filters).toString();
  const url = qs ? `/api/graph?${qs}` : "/api/graph";
  const resp = await fetch(url);
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json()).error ?? ""; } catch {}
    throw new Error(`fetchGraph failed: ${detail || resp.statusText}`);
  }
  return resp.json();
}

async function fetchSearch(q) {
  const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  if (!resp.ok) throw new Error("search failed");
  return resp.json();
}

// === MERGE ===
function mergeIntoLoaded({ nodes, edges }) {
  for (const n of nodes) {
    if (!loadedSet.nodes.get(n.id)) {
      loadedSet.nodes.add({
        id: n.id,
        label: n.label,
        color: GROUP_COLORS[n.group] ?? { background: "#6e7681", border: "#8b949e" },
        title: n.group,
        font: { color: "#c9d1d9" },
        _properties: n.properties,
        _group: n.group,
      });
    }
  }
  for (const e of edges) {
    loadedSet.edges.add({
      id: edgeIdCounter++,
      from: e.from,
      to: e.to,
      label: e.label,
      arrows: "to",
      color: { color: "#30363d", highlight: "#58a6ff" },
      font: { color: "#8b949e", size: 10 },
      _type: e.label,
    });
  }
}

// === RENDER ===
function initNetwork() {
  const container = document.getElementById("graph");
  network = new vis.Network(
    container,
    { nodes: loadedSet.nodes, edges: loadedSet.edges },
    {
      physics: { stabilization: { iterations: 100 } },
      edges: { smooth: { type: "continuous" } },
      interaction: { hover: true },
    }
  );

  network.on("click", onNodeClick);
}

function applyViewFilters() {
  const nodeUpdates = [];
  const edgeUpdates = [];
  const q = viewState.search.trim().toLowerCase();

  loadedSet.nodes.forEach((n) => {
    const typeHidden = !viewState.visibleNodeTypes.has(n._group);
    const matches = !q || (n.label && n.label.toLowerCase().includes(q));
    const hidden = typeHidden;
    const borderWidth = q && matches ? 4 : 1;
    const update = {};
    if (n.hidden !== hidden) update.hidden = hidden;
    if ((n.borderWidth ?? 1) !== borderWidth) update.borderWidth = borderWidth;
    if (Object.keys(update).length) {
      update.id = n.id;
      nodeUpdates.push(update);
    }
  });

  loadedSet.edges.forEach((e) => {
    const typeHidden = !viewState.visibleEdgeTypes.has(e._type);
    const fromNode = loadedSet.nodes.get(e.from);
    const toNode = loadedSet.nodes.get(e.to);
    const endpointHidden =
      (fromNode && fromNode.hidden) || (toNode && toNode.hidden);
    const hidden = typeHidden || !!endpointHidden;
    if (e.hidden !== hidden) {
      edgeUpdates.push({ id: e.id, hidden });
    }
  });

  if (nodeUpdates.length) loadedSet.nodes.update(nodeUpdates);
  if (edgeUpdates.length) loadedSet.edges.update(edgeUpdates);
  updateLoadedCounter();
}

function updateLoadedCounter() {
  const visibleNodes = loadedSet.nodes.get({ filter: (n) => !n.hidden }).length;
  const visibleEdges = loadedSet.edges.get({ filter: (e) => !e.hidden }).length;
  const el = document.getElementById("loaded-counter");
  if (el) {
    el.textContent = `Loaded: ${loadedSet.nodes.length} nodes, ${loadedSet.edges.length} edges (${visibleNodes}/${visibleEdges} visible)`;
  }
}

// === EVENTS ===
function onNodeClick(params) {
  if (params.nodes.length > 0) {
    const node = loadedSet.nodes.get(params.nodes[0]);
    document.getElementById("panel-hint").style.display = "none";
    const content = document.getElementById("panel-content");
    content.style.display = "block";
    content.textContent = `[${node._group}] ${node.label}\n\n${JSON.stringify(node._properties, null, 2)}`;
  }
}

function bindSidebarEvents() {
  document.querySelectorAll('input[data-node-type]').forEach((input) => {
    input.addEventListener("change", (e) => {
      const t = e.target.dataset.nodeType;
      if (e.target.checked) {
        viewState.visibleNodeTypes.add(t);
      } else {
        viewState.visibleNodeTypes.delete(t);
      }
      applyViewFilters();
    });
  });

  document.querySelectorAll('input[data-edge-type]').forEach((input) => {
    input.addEventListener("change", (e) => {
      const t = e.target.dataset.edgeType;
      if (e.target.checked) {
        viewState.visibleEdgeTypes.add(t);
      } else {
        viewState.visibleEdgeTypes.delete(t);
      }
      applyViewFilters();
    });
  });

  let searchTimer = null;
  const searchInput = document.getElementById("search-input");
  const searchResult = document.getElementById("search-result");
  searchInput.addEventListener("input", (e) => {
    viewState.search = e.target.value;
    applyViewFilters();

    // Count local matches
    const q = viewState.search.trim().toLowerCase();
    if (!q) {
      searchResult.textContent = "";
      return;
    }
    const localHits = loadedSet.nodes.get({
      filter: (n) => n.label && n.label.toLowerCase().includes(q),
    }).length;
    searchResult.textContent = `${localHits} local match${localHits === 1 ? "" : "es"}`;

    // Debounced server fallback for "load missing matches"
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      if (viewState.search.trim().length < 2) return;
      try {
        const data = await fetchSearch(viewState.search.trim());
        if (data.nodes && data.nodes.length > 0) {
          mergeIntoLoaded(data);
          applyViewFilters();
          searchResult.textContent = `${localHits} local + ${data.nodes.length} server match${data.nodes.length === 1 ? "" : "es"}`;
        } else if (localHits === 0) {
          searchResult.textContent = "No matches";
        }
      } catch {
        // Quietly ignore search failures — user is still typing
      }
    }, 350);
  });

  document.getElementById("reset-view-btn").addEventListener("click", () => {
    viewState.search = "";
    viewState.visibleNodeTypes = new Set(["Repository", "File", "Class", "Function"]);
    viewState.visibleEdgeTypes = new Set([
      "CONTAINS_FILE", "CONTAINS", "HAS_METHOD", "IMPORTS", "CALLS",
    ]);
    document.getElementById("search-input").value = "";
    document.getElementById("search-result").textContent = "";
    document.querySelectorAll('input[data-node-type]').forEach((i) => { i.checked = true; });
    document.querySelectorAll('input[data-edge-type]').forEach((i) => {
      i.checked = i.dataset.edgeType !== "IMPORTS_SYMBOL";
    });
    applyViewFilters();
  });

  document.getElementById("reset-all-btn").addEventListener("click", async () => {
    loadedSet.nodes.clear();
    loadedSet.edges.clear();
    edgeIdCounter = 0;
    try {
      const data = await fetchGraph(parseUrlFilters());
      mergeIntoLoaded(data);
      applyViewFilters();
    } catch (err) {
      document.getElementById("status").textContent = err.message;
    }
  });

  let physicsEnabled = true;
  document.getElementById("freeze-btn").addEventListener("click", (e) => {
    physicsEnabled = !physicsEnabled;
    network.setOptions({ physics: { enabled: physicsEnabled } });
    e.target.textContent = physicsEnabled ? "Freeze layout" : "Unfreeze layout";
  });
}

// === BOOT ===
async function boot() {
  const status = document.getElementById("status");
  status.textContent = "Fetching graph data...";

  let data;
  try {
    data = await fetchGraph(parseUrlFilters());
  } catch (err) {
    status.textContent = err.message;
    return;
  }

  if (data.nodes.length === 0) {
    status.textContent = "No graph data — run `code-graph-rag index` first, then refresh.";
    return;
  }

  initNetwork();
  bindSidebarEvents();
  mergeIntoLoaded(data);
  applyViewFilters();
  status.textContent = `${loadedSet.nodes.length} nodes, ${loadedSet.edges.length} edges`;
}

boot().catch(console.error);
