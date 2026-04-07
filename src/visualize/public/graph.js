const GROUP_COLORS = {
  Repository: { background: "#1f6feb", border: "#388bfd" },
  File: { background: "#1a7f37", border: "#2ea043" },
  Class: { background: "#8957e5", border: "#a371f7" },
  Function: { background: "#da3633", border: "#f85149" },
};

async function loadGraph() {
  const status = document.getElementById("status");
  status.textContent = "Fetching graph data...";

  let resp;
  try {
    resp = await fetch("/api/graph");
  } catch (err) {
    status.textContent = `Connection error: ${err.message}`;
    return;
  }

  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json()).error ?? ""; } catch {}
    status.textContent = `Failed to load graph: ${detail || resp.statusText}`;
    return;
  }

  const data = await resp.json();

  if (data.nodes.length === 0) {
    status.textContent = "No graph data — run `code-graph-rag index` first, then refresh.";
    return;
  }

  status.textContent = `${data.nodes.length} nodes, ${data.edges.length} edges`;

  const nodes = new vis.DataSet(
    data.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      color: GROUP_COLORS[n.group] ?? { background: "#6e7681", border: "#8b949e" },
      title: n.group,
      font: { color: "#c9d1d9" },
      _properties: n.properties,
      _group: n.group,
    }))
  );

  const edges = new vis.DataSet(
    data.edges.map((e, i) => ({
      id: i,
      from: e.from,
      to: e.to,
      label: e.label,
      arrows: "to",
      color: { color: "#30363d", highlight: "#58a6ff" },
      font: { color: "#8b949e", size: 10 },
    }))
  );

  const container = document.getElementById("graph");
  const network = new vis.Network(container, { nodes, edges }, {
    physics: { stabilization: { iterations: 100 } },
    edges: { smooth: { type: "continuous" } },
    interaction: { hover: true },
  });

  network.on("click", (params) => {
    if (params.nodes.length > 0) {
      const node = nodes.get(params.nodes[0]);
      document.getElementById("panel-hint").style.display = "none";
      const content = document.getElementById("panel-content");
      content.style.display = "block";
      content.textContent = `[${node._group}] ${node.label}\n\n${JSON.stringify(node._properties, null, 2)}`;
    }
  });
}

loadGraph().catch(console.error);
