import { useRef, useEffect, useState } from "preact/hooks";
import * as d3Force from "d3-force";
import * as d3Selection from "d3-selection";
import * as d3Zoom from "d3-zoom";
import { embed, cosineSim } from "@ternlight/mini";
import type { ClusterResult, TopicCluster } from "./cluster.ts";

interface Props {
  result: ClusterResult;
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

export function Graph({ result, onBack }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedIds, setHighlightedIds] = useState<Set<number>>(new Set());
  const [searching, setSearching] = useState(false);
  const simulationRef = useRef<d3Force.Simulation<SimNode, SimLink> | null>(null);

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
    const width = svgRef.current.clientWidth || 800;
    const height = 600;

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
    const simulation = d3Force.forceSimulation<SimNode>(nodes)
      .force("link", d3Force.forceLink<SimNode, SimLink>(links)
        .id((d: SimNode) => d.id)
        .distance((d: d3Force.SimulationLinkDatum<SimNode>) =>
          100 - (d as SimLink).sim * 60))
      .force("charge", d3Force.forceManyBody().strength(-200))
      .force("center", d3Force.forceCenter(width / 2, height / 2))
      .force("collision", d3Force.forceCollide<SimNode>().radius(
        (d: SimNode) => radiusScale(d.cluster.size) + 4));

    simulationRef.current = simulation;

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

    // Tick
    simulation.on("tick", () => {
      link
        .attr("x1", (d: SimLink) => (d.source as SimNode).x!)
        .attr("y1", (d: SimLink) => (d.source as SimNode).y!)
        .attr("x2", (d: SimLink) => (d.target as SimNode).x!)
        .attr("y2", (d: SimLink) => (d.target as SimNode).y!);

      node.attr("transform", (d: SimNode) => `translate(${d.x},${d.y})`);
    });

    return () => {
      simulation.stop();
    };
  }, [nodes, links, highlightedIds]);

  // Restart simulation on highlight change
  useEffect(() => {
    simulationRef.current?.alpha(0.3).restart();
  }, [highlightedIds]);

  // Search
  async function handleSearch() {
    if (!searchQuery.trim()) {
      setHighlightedIds(new Set());
      return;
    }
    setSearching(true);
    try {
      const queryVec = embed(searchQuery.trim());
      const scores = nodes.map((n, i) => ({
        i,
        sim: cosineSim(queryVec, new Float32Array(n.cluster.centroid)),
      }));
      scores.sort((a, b) => b.sim - a.sim);
      const highlighted = new Set(scores.slice(0, 5).map((s) => s.i));
      setHighlightedIds(highlighted);
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
    ? result.clusters.find((c) => c.id === selectedId) ?? null
    : null;

  const totalMessages = result.clusters.reduce((s, c) => s + c.size, 0);

  return (
    <div class="graph-container">
      <button class="back-btn" onClick={onBack} style="margin: 0 1rem 1rem;">
        ← Back to clusters
      </button>

      {/* Search bar */}
      <div class="graph-search">
        <input
          type="text"
          placeholder="Search clusters…"
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
            }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Graph + sidebar */}
      <div class="graph-layout">
        <svg ref={svgRef} class="graph-svg" viewBox="0 0 800 600" />

        {/* Sidebar */}
        {selectedCluster && (
          <div class="graph-sidebar">
            <h3>{selectedCluster.label}</h3>
            <p class="sidebar-meta">
              {selectedCluster.size} messages ·{" "}
              {Math.round((selectedCluster.size / totalMessages) * 100)}%
            </p>
            <p class="sidebar-desc">
              Click another cluster to compare, or click this one again to close.
            </p>
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
