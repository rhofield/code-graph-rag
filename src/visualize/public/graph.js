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

const EDGE_STYLES = {
  CONTAINS_FILE:  { color: "#1f6feb", width: 1 },
  CONTAINS:       { color: "#1a7f37", width: 1 },
  HAS_METHOD:     { color: "#8957e5", width: 1 },
  IMPORTS:        { color: "#d29922", width: 1.5 },
  CALLS:          { color: "#da3633", width: 1 },
  IMPORTS_SYMBOL: { color: "#6e7681", width: 1, dashes: true },
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
const pendingExpands = new Set();

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

async function fetchExpand(type, params) {
  const qs = new URLSearchParams({ type, ...params }).toString();
  const resp = await fetch(`/api/expand?${qs}`);
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json()).error ?? ""; } catch {}
    throw new Error(`expand failed: ${detail || resp.statusText}`);
  }
  return resp.json();
}

// === MERGE ===
function mergeIntoLoaded({ nodes, edges }, expandedFromId) {
  for (const n of nodes) {
    const existing = loadedSet.nodes.get(n.id);
    if (!existing) {
      loadedSet.nodes.add({
        id: n.id,
        label: n.label,
        color: GROUP_COLORS[n.group] ?? { background: "#6e7681", border: "#8b949e" },
        title: n.group,
        font: { color: "#c9d1d9" },
        _properties: n.properties,
        _group: n.group,
        _expanded: false,
        _expandedBy: expandedFromId ? new Set([expandedFromId]) : new Set(),
      });
    } else if (expandedFromId) {
      // Mark this node as also reachable from expandedFromId
      existing._expandedBy.add(expandedFromId);
    }
  }
  for (const e of edges) {
    const style = EDGE_STYLES[e.label] ?? { color: "#30363d", width: 1 };
    loadedSet.edges.add({
      id: edgeIdCounter++,
      from: e.from,
      to: e.to,
      label: e.label,
      arrows: "to",
      color: { color: style.color, highlight: "#58a6ff" },
      width: style.width,
      dashes: style.dashes ?? false,
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
      physics: {
        solver: "forceAtlas2Based",
        forceAtlas2Based: {
          gravitationalConstant: -50,
          centralGravity: 0.01,
          springLength: 150,
          springConstant: 0.08,
          damping: 0.4,
          avoidOverlap: 0.5,
        },
        stabilization: { iterations: 250, updateInterval: 25 },
        minVelocity: 0.5,
      },
      edges: {
        smooth: { type: "continuous", roundness: 0.2 },
        font: { size: 0, strokeWidth: 0 },
        arrows: { to: { scaleFactor: 0.6 } },
      },
      interaction: { hover: true, hoverConnectedEdges: true },
    }
  );

  network.on("click", onNodeClick);
  network.on("doubleClick", onNodeDoubleClick);
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

function degreeToSize(degree) {
  return Math.min(35, 12 + Math.sqrt(degree) * 4);
}

function recomputeNodeSizes() {
  const degree = new Map();
  loadedSet.edges.forEach((e) => {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  });

  const updates = [];
  loadedSet.nodes.forEach((n) => {
    const newSize = degreeToSize(degree.get(n.id) ?? 0);
    if (n.size !== newSize) {
      updates.push({ id: n.id, size: newSize });
    }
  });
  if (updates.length) loadedSet.nodes.update(updates);
}

// === EVENTS ===
async function onNodeClick(params) {
  if (params.nodes.length === 0) return;
  const nodeId = params.nodes[0];
  const node = loadedSet.nodes.get(nodeId);

  // Always update the detail panel
  document.getElementById("panel-hint").style.display = "none";
  const content = document.getElementById("panel-content");
  content.style.display = "block";
  content.textContent = `[${node._group}] ${node.label}\n\n${JSON.stringify(node._properties, null, 2)}`;

  // Expand if not already expanded and not already in flight
  if (node._expanded || pendingExpands.has(nodeId)) return;

  if (node._group === "File") {
    pendingExpands.add(nodeId);
    try {
      const data = await fetchExpand("file", { filePath: node._properties.path });
      mergeIntoLoaded(data, nodeId);
      recomputeNodeSizes();
      // Mark file as expanded
      loadedSet.nodes.update({ id: nodeId, _expanded: true });
      applyViewFilters();
    } catch (err) {
      document.getElementById("status").textContent = err.message;
    } finally {
      pendingExpands.delete(nodeId);
    }
  } else if (node._group === "Function") {
    pendingExpands.add(nodeId);
    try {
      const data = await fetchExpand("function", {
        name: node._properties.name,
        filePath: node._properties.filePath,
      });
      mergeIntoLoaded(data, nodeId);
      recomputeNodeSizes();
      loadedSet.nodes.update({ id: nodeId, _expanded: true });
      applyViewFilters();
    } catch (err) {
      document.getElementById("status").textContent = err.message;
    } finally {
      pendingExpands.delete(nodeId);
    }
  }
  // Repository and Class clicks: detail panel only, no expand.
}

function onNodeDoubleClick(params) {
  if (params.nodes.length === 0) return;
  const nodeId = params.nodes[0];
  const node = loadedSet.nodes.get(nodeId);
  if (!node || !node._expanded) return;

  // Find every node that was loaded *because of* nodeId
  const candidatesToRemove = loadedSet.nodes.get({
    filter: (n) => n._expandedBy && n._expandedBy.has(nodeId),
  });

  const removeIds = [];
  for (const cand of candidatesToRemove) {
    cand._expandedBy.delete(nodeId);
    if (cand._expandedBy.size === 0) {
      removeIds.push(cand.id);
    }
  }

  if (removeIds.length > 0) {
    // Remove edges touching removed nodes
    const removeIdsSet = new Set(removeIds);
    const edgeIds = loadedSet.edges.get({
      filter: (e) => removeIdsSet.has(e.from) || removeIdsSet.has(e.to),
      fields: ["id"],
    }).map((e) => e.id);

    loadedSet.edges.remove(edgeIds);
    loadedSet.nodes.remove(removeIds);
    recomputeNodeSizes();
  }

  loadedSet.nodes.update({ id: nodeId, _expanded: false });
  applyViewFilters();
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
          recomputeNodeSizes();
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
      recomputeNodeSizes();
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

  initNetwork();
  bindSidebarEvents();

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

  mergeIntoLoaded(data);
  recomputeNodeSizes();
  applyViewFilters();
  status.textContent = `${loadedSet.nodes.length} nodes, ${loadedSet.edges.length} edges`;
}

boot().catch(console.error);
