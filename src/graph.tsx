import { useRef, useEffect, useState } from "preact/hooks";
import * as d3Force from "d3-force";
import * as d3Selection from "d3-selection";
import * as d3Zoom from "d3-zoom";
import * as d3Drag from "d3-drag";
import { embed, cosineSim } from "@ternlight/mini";
import MiniSearch from "minisearch";
import type { ClusterResult, TopicCluster } from "./cluster.ts";
import { getMessagesByIds, getEmbeddedMessages, type StoredMessage } from "./db.ts";
import { safeText } from "./utils.ts";

interface Props {
  result: ClusterResult;
  convoId: string;
  onBack: () => void;
}

interface SimNode extends d3Force.SimulationNodeDatum {
  id: number;
  cluster: TopicCluster;
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
  vx?: number;
  vy?: number;
}

interface SimLink extends d3Force.SimulationLinkDatum<SimNode> {
  sim: number;
}

export function Graph({ result, convoId, onBack }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [clusterMessages, setClusterMessages] = useState<StoredMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedIds, setHighlightedIds] = useState<Set<number>>(new Set());
  const [searching, setSearching] = useState(false);
  const [searchMode, setSearchMode] = useState<"semantic" | "fuzzy">("semantic");
  const [fuzzyLevel, setFuzzyLevel] = useState(0.4);
  const simulationRef = useRef<d3Force.Simulation<SimNode, SimLink> | null>(null);
  const miniSearchRef = useRef<MiniSearch | null>(null);
  const msgCacheRef = useRef<Map<string, StoredMessage>>(new Map());
  const [searchResults, setSearchResults] = useState<{msg: StoredMessage; score: number; matchTerms?: string[]}[]>([]);
  const miniReady = useRef(false);

  // Build MiniSearch index for fuzzy cluster search
  useEffect(() => {
    if (miniReady.current) return;
    miniReady.current = true;
    getEmbeddedMessages(convoId).then((msgs) => {
      for (const m of msgs) msgCacheRef.current.set(m.id, m);
      const mini = new MiniSearch({
        fields: ["text", "senderDisplayName", "senderHandle"],
        storeFields: ["id"],
        searchOptions: { boost: { text: 2 }, fuzzy: 0.4, prefix: true },
      });
      mini.addAll(msgs.map((m) => ({ id: m.id, text: m.text, senderDisplayName: m.senderDisplayName ?? "", senderHandle: m.senderHandle ?? "" })));
      miniSearchRef.current = mini;
    }).catch(() => {});
  }, []);

  // Build graph data
  const nodes: SimNode[] = result.clusters.map((c, i) => ({
    id: i,
    cluster: c,
  }));

  const nodeMap = new Map(nodes.map((n) => [n.id, n] as const));
  const links: SimLink[] = result.similarities
    .filter((s) => nodeMap.has(s.from) && nodeMap.has(s.to))
    .map((s) => ({
      source: s.from,
      target: s.to,
      sim: s.sim,
    }));

  // Run force simulation
  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;

    const svg = d3Selection.select(svgRef.current);
    const container = svgRef.current.parentElement!;
    const width = container.clientWidth;
    const height = Math.max(500, window.innerHeight * 0.65);

    svg.attr("viewBox", `0 0 ${width} ${height}`);
    svg.attr("preserveAspectRatio", "xMidYMid meet");

    svg.selectAll("*").remove();

    const g = svg.append("g");

    // Zoom
    const zoomBehavior = d3Zoom.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on("zoom", (event: d3Zoom.D3ZoomEvent<SVGSVGElement, unknown>) => {
        g.attr("transform", event.transform.toString());
      });
    svg.call(zoomBehavior);

    // Simulation
    const chargeStrength = -width * 0.35;
    const chargeForce = d3Force.forceManyBody().strength(chargeStrength);
    const centerForce = d3Force.forceCenter(width / 2, height / 2);

    const simulation = d3Force.forceSimulation<SimNode>(nodes)
      .force("link", d3Force.forceLink<SimNode, SimLink>(links)
        .id((d: SimNode) => d.id)
        .distance((d: d3Force.SimulationLinkDatum<SimNode>) => 80 - (d as SimLink).sim * 40))
      .force("charge", chargeForce)
      .force("center", centerForce.strength(0.15))
      .force("collision", d3Force.forceCollide<SimNode>().radius(
        (d: SimNode) => radiusScale(d.cluster.size) + 6))
      .force("bounds", () => {
        for (const n of nodes) {
          const r = radiusScale(n.cluster.size) + 10;
          n.x = Math.max(r, Math.min(width - r, n.x!));
          n.y = Math.max(r, Math.min(height - r, n.y!));
        }
      })
      .stop();

    simulationRef.current = simulation;

    // Run simulation to completion, then scale graph to fill viewport
    for (let i = 0; i < 300; i++) simulation.tick();
    
    // Compute bounding box of all nodes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const r = radiusScale(n.cluster.size);
      if (n.x! - r < minX) minX = n.x! - r;
      if (n.y! - r < minY) minY = n.y! - r;
      if (n.x! + r > maxX) maxX = n.x! + r;
      if (n.y! + r > maxY) maxY = n.y! + r;
    }
    
    // Auto-fit: scale+translate to fill 90% of viewport
    const graphW = maxX - minX || 1;
    const graphH = maxY - minY || 1;
    const s = Math.min(width / graphW, height / graphH) * 0.9;
    const tx = (width - graphW * s) / 2 - minX * s;
    const ty = (height - graphH * s) / 2 - minY * s;
    
    // Use zoom identity (so pan/zoom work relative to auto-fit)
    zoomBehavior.transform(svg, d3Zoom.zoomIdentity.translate(tx, ty).scale(s));

    // Draw links
    const link = g.append("g")
      .selectAll<SVGLineElement, SimLink>("line")
      .data(links)
      .join("line")
      .attr("stroke", "#30363d")
      .attr("stroke-width", (d: SimLink) => Math.max(0.5, d.sim * 3))
      .attr("stroke-opacity", (d: SimLink) => 0.3 + d.sim * 0.4);

    // Draw nodes
    const node = g.append("g")
      .selectAll<SVGGElement, SimNode>("g")
      .data(nodes)
      .join("g")
      .attr("cursor", "pointer")
      .on("click", (_event: MouseEvent, d: SimNode) => {
        setSelectedId((prev) => (prev === d.id ? null : d.id));
      });

    node.append("circle")
      .attr("r", (d: SimNode) => radiusScale(d.cluster.size))
      .attr("fill", (d: SimNode) => colorScale(d.id, nodes.length))
      .attr("stroke", (d: SimNode) =>
        highlightedIds.has(d.id) ? "#ffff00" : "#1c2333")
      .attr("stroke-width", (d: SimNode) =>
        highlightedIds.has(d.id) ? 3 : 1);

    node.append("text")
      .text((d: SimNode) => d.cluster.label.slice(0, 18))
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .attr("fill", "#e6edf3")
      .attr("font-size", (d: SimNode) =>
        `${Math.max(8, Math.min(12, radiusScale(d.cluster.size) * 0.5))}`)
      .attr("pointer-events", "none");

    // Tooltips
    node.append("title")
      .text((d: SimNode) => `${d.cluster.label}\n${d.cluster.size} messages`);

    // Drag behavior
    const drag = d3Drag.drag<SVGGElement, SimNode>()
      .on("start", (event: d3Drag.D3DragEvent<SVGGElement, SimNode, SimNode>, d: SimNode) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event: d3Drag.D3DragEvent<SVGGElement, SimNode, SimNode>, d: SimNode) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event: d3Drag.D3DragEvent<SVGGElement, SimNode, SimNode>, d: SimNode) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
    node.call(drag);

    // Tick
    simulation.on("tick", () => {
      link
        .attr("x1", (d: SimLink) => (d.source as SimNode).x!)
        .attr("y1", (d: SimLink) => (d.source as SimNode).y!)
        .attr("x2", (d: SimLink) => (d.target as SimNode).x!)
        .attr("y2", (d: SimLink) => (d.target as SimNode).y!);

      node.attr("transform", (d: SimNode) => `translate(${d.x},${d.y})`);
    });

    // Respond to window resize
    const resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = Math.max(500, window.innerHeight * 0.65);
      svg.attr("viewBox", `0 0 ${w} ${h}`);
      centerForce.x(w / 2).y(h / 2);
      simulation.alpha(0.3).restart();
    });
    resizeObserver.observe(container);

    return () => {
      simulation.stop();
      resizeObserver.disconnect();
    };
  }, [nodes, links]);

  // Update node highlights without recreating the graph
  useEffect(() => {
    const svg = d3Selection.select(svgRef.current);
    svg.selectAll<SVGGElement, SimNode>("g g")
      .select("circle")
      .attr("stroke", (d: SimNode) =>
        highlightedIds.has(d.id) ? "#ffff00" : "#1c2333")
      .attr("stroke-width", (d: SimNode) =>
        highlightedIds.has(d.id) ? 3 : 1);
  }, [highlightedIds]);

  // Restart simulation on highlight change
  useEffect(() => {
    simulationRef.current?.alpha(0.3).restart();
  }, [highlightedIds]);

  // Fetch cluster messages when selection changes
  useEffect(() => {
    if (selectedId == null) {
      setClusterMessages([]);
      return;
    }
    const cluster = nodes[selectedId]?.cluster;
    if (!cluster) return;
    setLoadingMessages(true);
    getMessagesByIds(cluster.messageIds).then((msgs) => {
      // Find top 5 messages closest to centroid (representative samples)
      const centroid = new Float32Array(cluster.centroid);
      const ranked = msgs
        .filter((m) => m.embedding)
        .map((m) => ({
          msg: m,
          sim: cosineSim(new Float32Array(m.embedding!), centroid),
        }))
        .sort((a, b) => b.sim - a.sim);
      setClusterMessages(ranked.slice(0, 5).map((r) => r.msg));
    }).catch(() => {
      // Ignore errors
    }).finally(() => {
      setLoadingMessages(false);
    });
  }, [selectedId, result.clusters]);

  // Search
  async function handleSearch() {
    if (!searchQuery.trim()) {
      setHighlightedIds(new Set());
      return;
    }
    setSearching(true);
    let msgResults: {msg: StoredMessage; score: number; matchTerms?: string[]}[] = [];
    try {
      if (searchMode === "fuzzy") {
        const mini = miniSearchRef.current;
        if (!mini) return;
        const hits = mini.search(searchQuery.trim(), { fuzzy: fuzzyLevel, prefix: true });
        const clusterByMsg = new Map<string, number>();
        for (const n of nodes) {
          for (const mid of n.cluster.messageIds) {
            clusterByMsg.set(mid, n.id);
          }
        }
        const matchedClusters = new Set<number>();
        for (const h of hits) {
          const cid = clusterByMsg.get(h.id);
          if (cid != null) matchedClusters.add(cid);
        }
        setHighlightedIds(matchedClusters);
        msgResults = hits.slice(0, 20).map((h) => ({
          msg: msgCacheRef.current.get(h.id)!,
          score: h.score,
          matchTerms: Object.keys(h.match).filter((k) => h.match[k].length > 0),
        })).filter((r) => r.msg);
      } else {
        const queryVec = embed(searchQuery.trim());
        const scores = nodes.map((n, i) => ({
          i,
          sim: cosineSim(queryVec, new Float32Array(n.cluster.centroid)),
        }));
        scores.sort((a, b) => b.sim - a.sim);
        const highlighted = new Set(scores.slice(0, 5).map((s) => s.i));
        setHighlightedIds(highlighted);
      }
      setSearchResults(msgResults);
    } catch {
      // Ignore search errors
    } finally {
      setSearching(false);
    }
  }

  // Size scale
  function radiusScale(count: number): number {
    const minR = 8;
    const maxR = 60;
    const maxCount = Math.max(...nodes.map((n) => n.cluster.size), 1);
    return minR + (count / maxCount) * (maxR - minR);
  }

  // Color scale
  function colorScale(i: number, total: number): string {
    const hue = (i / total) * 280 + 180;
    return `hsl(${hue}, 60%, 55%)`;
  }

  const selectedCluster = selectedId != null
    ? (nodes[selectedId]?.cluster ?? null)
    : null;

  const totalMessages = result.clusters.reduce((s, c) => s + c.size, 0);

  return (
    <div class="graph-container">
      <button class="back-btn" onClick={onBack} style="margin: 0 1rem 1rem;">
        ← Back to clusters
      </button>

      {/* Search bar */}
      <div class="graph-search">
        <div class="search-mode-bar">
          <label class="search-mode-label">
            <input
              type="radio"
              name="graph-search-mode"
              checked={searchMode === "semantic"}
              onChange={() => setSearchMode("semantic")}
            />
            Semantic
          </label>
          <label class="search-mode-label">
            <input
              type="radio"
              name="graph-search-mode"
              checked={searchMode === "fuzzy"}
              onChange={() => setSearchMode("fuzzy")}
            />
            Fuzzy
          </label>
          {searchMode === "fuzzy" && (
            <label class="fuzzy-slider">
              <span>Fuzziness: {fuzzyLevel.toFixed(1)}</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={fuzzyLevel}
                onInput={(e) => setFuzzyLevel(Number(e.currentTarget.value))}
              />
            </label>
          )}
        </div>
        <input
          type="text"
          placeholder="Search clusters..."
          value={searchQuery}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
        <button onClick={handleSearch} disabled={searching}>
          {searching ? "…" : "Search"}
        </button>
        {highlightedIds.size > 0 && (
          <button
            class="clear-search"
            onClick={() => {
              setSearchQuery("");
              setHighlightedIds(new Set());
              setSearchResults([]);
            }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Graph + sidebar */}
      <div class="graph-layout">
        <svg ref={svgRef} class="graph-svg" />

        {/* Sidebar */}
        {selectedCluster && (
          <div class="graph-sidebar">
            <h3>{selectedCluster.label}</h3>
            <p class="sidebar-meta">
              {selectedCluster.size} messages ·{" "}
              {Math.round((selectedCluster.size / totalMessages) * 100)}%
            </p>
            {loadingMessages && (
              <p class="sidebar-loading">Loading messages…</p>
            )}
            {!loadingMessages && clusterMessages.length > 0 && (
              <ul class="sidebar-messages">
                {clusterMessages.map((m) => (
                  <li key={m.id} class="sidebar-msg">
                    <div class="sidebar-msg-sender">{m.senderDisplayName || m.senderHandle || "unknown"}</div>
                    <div class="sidebar-msg-text">{safeText(m.text).slice(0, 140)}{m.text.length > 140 ? "…" : ""}</div>
                  </li>
                ))}
              </ul>
            )}
            <p class="sidebar-desc">
              Click another cluster to compare, or click this one again to close.
            </p>
          </div>
        )}

        {/* Search results panel (when no cluster selected) */}
        {!selectedCluster && searchResults.length > 0 && (
          <div class="graph-sidebar">
            <h3>🔍 Search results</h3>
            <p class="sidebar-meta">{searchResults.length} matches</p>
            <ul class="sidebar-messages">
              {searchResults.map((r) => (
                <li key={r.msg.id} class="sidebar-msg">
                  <div class="sidebar-msg-sender">
                    {r.msg.senderDisplayName || r.msg.senderHandle || "unknown"}
                    {r.matchTerms && r.matchTerms.length > 0 && (
                      <span class="match-terms"> — {r.matchTerms.slice(0, 2).join(", ")}</span>
                    )}
                  </div>
                  <div class="sidebar-msg-text">{safeText(r.msg.text).slice(0, 140)}{r.msg.text.length > 140 ? "…" : ""}</div>
                  <div class="sidebar-msg-time">{new Date(r.msg.sentAt).toLocaleString()}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Footer */}
      <div class="graph-footer">
        <span>
          {result.clusters.length} clusters · {totalMessages} messages
        </span>
        <span>{result.replyChains?.length ?? 0} reply chains</span>
      </div>
    </div>
  );
}
