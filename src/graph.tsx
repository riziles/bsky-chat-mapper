import { useRef, useEffect, useState, useMemo } from "preact/hooks";
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
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [clusterMessages, setClusterMessages] = useState<StoredMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedIds, setHighlightedIds] = useState<Set<number>>(new Set());
  const [searching, setSearching] = useState(false);
  const [searchMode, setSearchMode] = useState<"semantic" | "fuzzy">("semantic");
  const [fuzzyLevel, setFuzzyLevel] = useState(0.2);
  const simulationRef = useRef<d3Force.Simulation<SimNode, SimLink> | null>(null);
  const miniSearchRef = useRef<MiniSearch | null>(null);
  const msgCacheRef = useRef<Map<string, StoredMessage>>(new Map());
  const [searchResults, setSearchResults] = useState<{msg: StoredMessage; score: number; matchTerms?: string[]}[]>([]);
  const [posterFilter, setPosterFilter] = useState("");
  const [senders, setSenders] = useState<{did: string; displayName: string; handle: string}[]>([]);
  const [showPosterDropdown, setShowPosterDropdown] = useState(false);
  const [activePosterIdx, setActivePosterIdx] = useState(-1);
  const posterInputRef = useRef<HTMLInputElement>(null);
  const miniReady = useRef(false);

  // Resolve posterFilter text (display name or handle) to sender DID
  const posterDid = useMemo(() => {
    if (!posterFilter.trim()) return null;
    const q = posterFilter.trim().toLowerCase();
    return senders.find(
      (s) => s.displayName.toLowerCase() === q || s.handle.toLowerCase() === q || s.did === q,
    )?.did ?? null;
  }, [posterFilter, senders]);

  // Filtered senders for autocomplete dropdown
  const filteredSenders = useMemo(() => {
    if (!posterFilter.trim()) return senders;
    const q = posterFilter.toLowerCase();
    return senders.filter(
      (s) =>
        s.displayName.toLowerCase().includes(q) ||
        s.handle.toLowerCase().includes(q),
    );
  }, [posterFilter, senders]);

  function selectPoster(s: { did: string; displayName: string; handle: string }) {
    setPosterFilter(s.displayName || s.handle);
    setShowPosterDropdown(false);
    setActivePosterIdx(-1);
  }

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

      // Collect unique senders for autocomplete
      const seen = new Map<string, {did: string; displayName: string; handle: string}>();
      for (const m of msgs) {
        if (seen.has(m.senderDid)) continue;
        seen.set(m.senderDid, {
          did: m.senderDid,
          displayName: m.senderDisplayName ?? "",
          handle: m.senderHandle ?? "",
        });
      }
      setSenders(
        Array.from(seen.values()).sort((a, b) =>
          (a.displayName || a.handle).localeCompare(b.displayName || b.handle),
        ),
      );
    }).catch(() => {});
  }, []);

  // Build graph data (memoized to avoid re-render flickering)
  const nodes: SimNode[] = useMemo(
    () => result.clusters.map((c, i) => ({ id: i, cluster: c })),
    [result.clusters],
  );

  const nodeMap = new Map(nodes.map((n) => [n.id, n] as const));
  const links: SimLink[] = useMemo(
    () =>
      result.similarities
        .filter((s) => nodeMap.has(s.from) && nodeMap.has(s.to))
        .map((s) => ({
          source: s.from,
          target: s.to,
          sim: s.sim,
        })),
    [result.similarities, nodes],
  );

  const selectedClusters = useMemo(() => {
    const out: TopicCluster[] = [];
    for (const id of selectedIds) {
      if (nodes[id]) out.push(nodes[id].cluster);
    }
    return out;
  }, [selectedIds, nodes]);

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
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(d.id)) next.delete(d.id);
          else next.add(d.id);
          return next;
        });
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
    if (selectedClusters.length === 0) {
      setClusterMessages([]);
      return;
    }
    setLoadingMessages(true);
    const allIds = new Set<string>();
    for (const c of selectedClusters) {
      for (const mid of c.messageIds) allIds.add(mid);
    }
    getMessagesByIds([...allIds]).then((msgs) => {
      // Show up to 5 per cluster, deduped
      const seen = new Set<string>();
      const combined: StoredMessage[] = [];
      for (const c of selectedClusters) {
        const centroid = new Float32Array(c.centroid);
        const clusterMsgs = msgs
          .filter((m) => m.embedding && c.messageIds.includes(m.id))
          .map((m) => ({
            msg: m,
            sim: cosineSim(new Float32Array(m.embedding!), centroid),
          }))
          .sort((a, b) => b.sim - a.sim);
        for (const { msg } of clusterMsgs) {
          if (combined.length >= 5 * selectedClusters.length) break;
          if (!seen.has(msg.id)) {
            seen.add(msg.id);
            combined.push(msg);
          }
        }
      }
      setClusterMessages(combined);
    }).catch(() => {
      // Ignore errors
    }).finally(() => {
      setLoadingMessages(false);
    });
  }, [selectedIds, result.clusters]);

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
        const filtered: typeof hits = [];
        for (const h of hits) {
          // Apply poster filter if set
          if (posterDid) {
            const msg = msgCacheRef.current.get(h.id);
            if (!msg || msg.senderDid !== posterDid) continue;
          }
          const cid = clusterByMsg.get(h.id);
          if (cid != null) matchedClusters.add(cid);
          filtered.push(h);
        }
        setHighlightedIds(matchedClusters);
        msgResults = filtered.slice(0, 20).map((h) => ({
          msg: msgCacheRef.current.get(h.id)!,
          score: h.score,
          matchTerms: Object.keys(h.match).filter((k) => h.match[k].length > 0),
        })).filter((r) => r.msg);
      } else {
        const queryVec = embed(searchQuery.trim());
        let scores = nodes.map((n, i) => ({
          i,
          sim: cosineSim(queryVec, new Float32Array(n.cluster.centroid)),
        }));
        // If poster filter is active, boost clusters containing messages from that poster
        if (posterDid) {
          scores = scores.map((s) => {
            const hasPosterMsgs = nodes[s.i].cluster.messageIds.some(
              (mid) => msgCacheRef.current.get(mid)?.senderDid === posterDid,
            );
            return { i: s.i, sim: hasPosterMsgs ? s.sim : -1 };
          });
        }
        scores.sort((a, b) => b.sim - a.sim);
        const top = scores.slice(0, 5).filter((s) => s.sim > 0);
        const highlighted = new Set(top.map((s) => s.i));
        setHighlightedIds(highlighted);

        // Return message-level results from top clusters
        const ranked: {msg: StoredMessage; score: number; matchTerms?: string[]}[] = [];
        const seen = new Set<string>();
        for (const { i } of top) {
          let msgs = nodes[i].cluster.messageIds
            .map((mid) => msgCacheRef.current.get(mid))
            .filter((m): m is StoredMessage => !!m?.embedding);
          if (posterDid) msgs = msgs.filter((m) => m.senderDid === posterDid);
          for (const m of msgs) {
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            ranked.push({
              msg: m,
              score: cosineSim(queryVec, new Float32Array(m.embedding!)),
            });
          }
        }
        ranked.sort((a, b) => b.score - a.score);
        msgResults = ranked.slice(0, 20);
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
              <span>Fuzziness: {fuzzyLevel.toFixed(2)}</span>
              <input
                type="range"
                min="0"
                max="0.4"
                step="0.05"
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
        <div class="poster-filter">
          <input
            type="text"
            ref={posterInputRef}
            placeholder="Filter by poster…"
            value={posterFilter}
            onInput={(e) => {
              setPosterFilter(e.currentTarget.value);
              setShowPosterDropdown(true);
              setActivePosterIdx(-1);
            }}
            onFocus={() => setShowPosterDropdown(true)}
            onBlur={() => setTimeout(() => setShowPosterDropdown(false), 150)}
            onKeyDown={(e) => {
              if (!showPosterDropdown || filteredSenders.length === 0) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActivePosterIdx((prev) =>
                  prev < filteredSenders.length - 1 ? prev + 1 : 0,
                );
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActivePosterIdx((prev) =>
                  prev > 0 ? prev - 1 : filteredSenders.length - 1,
                );
              } else if (e.key === "Enter" && activePosterIdx >= 0) {
                e.preventDefault();
                selectPoster(filteredSenders[activePosterIdx]);
              } else if (e.key === "Escape") {
                setShowPosterDropdown(false);
                setActivePosterIdx(-1);
              }
            }}
          />
          {showPosterDropdown && filteredSenders.length > 0 && (
            <ul class="poster-dropdown">
              {filteredSenders.map((s, i) => (
                <li
                  key={s.did}
                  class={i === activePosterIdx ? "active" : ""}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectPoster(s);
                  }}
                  onMouseEnter={() => setActivePosterIdx(i)}
                >
                  {s.displayName || s.handle}
                  {s.displayName && s.handle && (
                    <span class="handle-hint">@{s.handle}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {posterFilter && (
            <button
              class="clear-poster"
              onClick={() => {
                setPosterFilter("");
                setActivePosterIdx(-1);
              }}
              title="Clear poster filter"
            >
              ✕
            </button>
          )}
        </div>
        <button onClick={handleSearch} disabled={searching}>
          {searching ? "…" : "Search"}
        </button>
        {highlightedIds.size > 0 && (
          <button
            class="clear-search"
            onClick={() => {
              setSearchQuery("");
              setPosterFilter("");
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
        {selectedClusters.length > 0 && (
          <div class="graph-sidebar">
            <h3>{selectedClusters.map((c) => c.label).join(" · ")}</h3>
            <p class="sidebar-meta">
              {selectedClusters.reduce((s, c) => s + c.size, 0)} messages across {selectedClusters.length} cluster{selectedClusters.length > 1 ? "s" : ""} ·{" "}
              {Math.round((selectedClusters.reduce((s, c) => s + c.size, 0) / totalMessages) * 100)}%
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
        {selectedClusters.length === 0 && searchResults.length > 0 && (
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
