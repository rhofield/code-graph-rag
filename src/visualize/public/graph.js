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
  // Phase 2 placeholder — full implementation arrives in Phase 3.
  // For now, behavior matches the old code: everything is visible.
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
  mergeIntoLoaded(data);
  applyViewFilters();
  status.textContent = `${loadedSet.nodes.length} nodes, ${loadedSet.edges.length} edges`;
}

boot().catch(console.error);
