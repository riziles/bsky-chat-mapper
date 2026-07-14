import { useState, useEffect, useRef } from "preact/hooks";
import { login, logout, tryRestoreSession } from "./auth.ts";
import {
  listConvos,
  fetchMessages,
  type ConvoSummary,
  type FetchProgress,
  type MessageView,
} from "./api.ts";
import { storeMessages, storeEmbeddings, getMessagesForConvo, getLatestTimestamp, type StoredMessage } from "./db.ts";
import type { AtpAgent } from "@atproto/api";
import type { ClusterResult } from "./cluster.ts";
import { Graph } from "./graph.tsx";
import { MessageSearch } from "./search.tsx";
import "./app.css";

type AppState = "loading" | "login" | "picker" | "processing" | "graph";

// Processing phases within the processing view
type Phase = "fetch" | "embed" | "cluster" | "done";

type TimeRange = "7d" | "1m" | "3m" | "6m" | "12m" | "all" | "custom";

function timeRangeToDate(range: TimeRange, customDays?: number): Date | undefined {
  if (range === "all") return undefined;
  if (range === "7d") {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d;
  }
  if (range === "custom" && customDays) {
    const d = new Date();
    d.setDate(d.getDate() - customDays);
    return d;
  }
  const months: Record<string, number> = {
    "1m": 1,
    "3m": 3,
    "6m": 6,
    "12m": 12,
  };
  const d = new Date();
  d.setMonth(d.getMonth() - months[range]);
  return d;
}

export function App() {
  const [state, setState] = useState<AppState>("loading");
  const [handle, setHandle] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [pdsUrl, setPdsUrl] = useState("https://bsky.social");
  const [error, setError] = useState<string | null>(null);
  const [a, setAgent] = useState<AtpAgent | null>(null);
  const [convos, setConvos] = useState<ConvoSummary[]>([]);
  const [loadingConvos, setLoadingConvos] = useState(false);

  // Processing state
  const [selectedConvo, setSelectedConvo] = useState<ConvoSummary | null>(null);
  const [phase, setPhase] = useState<Phase>("fetch");
  const [timeRange, setTimeRange] = useState<TimeRange>("7d");
  const [customDays, setCustomDays] = useState<number>(30);
  const [fetching, setFetching] = useState(false);
  const [fetchProgress, setFetchProgress] = useState<FetchProgress | null>(null);
  const [fetchedMsgs, setFetchedMsgs] = useState<MessageView[]>([]);
  const [fetchAbort, setFetchAbort] = useState<AbortController | null>(null);

  // Embedding state
  const [embedding, setEmbedding] = useState(false);
  const [embedProgress, setEmbedProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const workerRef = useRef<Worker | null>(null);

  // Cluster state
  const [clustering, setClustering] = useState(false);
  const [clusterResult, setClusterResult] = useState<ClusterResult | null>(null);
  const [isIncremental, setIsIncremental] = useState(false);
  const [existingCount, setExistingCount] = useState(0);
  const autoStartedRef = useRef<Set<string>>(new Set());
  const [userStarted, setUserStarted] = useState(false);

  // Try to restore a session if one exists
  useEffect(() => {
    tryRestoreSession().then((agent) => {
      if (agent) {
        setAgent(agent);
        setState("picker");
        loadConvos(agent);
      } else {
        setState("login");
      }
    });
  }, []);

  // Auto-advance between phases when steps complete
  useEffect(() => {
    if (phase === "fetch" && fetchProgress?.done && fetchedMsgs.length > 0) {
      setPhase("embed");
    }
  }, [phase, fetchProgress?.done, fetchedMsgs.length]);

  useEffect(() => {
    if (phase === "embed" && embedProgress && !embedding) {
      setPhase("cluster");
    }
  }, [phase, embedProgress, embedding]);

  async function loadConvos(agent: AtpAgent) {
    setLoadingConvos(true);
    setError(null);
    try {
      const list = await listConvos(agent);
      setConvos(list);
    } catch (e: unknown) {
      setError((e as Error)?.message ?? "Failed to load conversations");
    } finally {
      setLoadingConvos(false);
    }
  }

  async function handleLogin(e: Event) {
    e.preventDefault();
    if (!handle.trim() || !appPassword.trim()) return;
    setError(null);
    try {
      const agent = await login(handle.trim(), appPassword.trim(), pdsUrl.trim() || "https://bsky.social");
      setAgent(agent);
      setState("picker");
      loadConvos(agent);
    } catch (e: unknown) {
      setError((e as Error)?.message ?? "Login failed");
    }
  }

  function handleLogout() {
    logout();
    setAgent(null);
    setConvos([]);
    setHandle("");
    setAppPassword("");
    setPdsUrl("https://bsky.social");
    setState("login");
  }

  function selectConvo(convo: ConvoSummary) {
    setSelectedConvo(convo);
    setPhase("fetch");
    setTimeRange("7d");
    setCustomDays(30);
    setFetching(false);
    setFetchProgress(null);
    setFetchedMsgs([]);
    setEmbedding(false);
    setEmbedProgress(null);
    setClustering(false);
    setClusterResult(null);
    setIsIncremental(false);
    setExistingCount(0);
    autoStartedRef.current = new Set();
    setUserStarted(false);
    setError(null);
    terminateWorker();
    setState("processing");
  }

  function backToPicker() {
    setState("picker");
    setSelectedConvo(null);
    terminateWorker();
    loadConvos(a!);
  }

  // --- Fetch ---
  async function startFetch() {
    if (!a || !selectedConvo) return;
    setUserStarted(true);
    setFetching(true);
    setError(null);
    setFetchProgress({ fetched: 0, oldestDate: null, done: false });

    const controller = new AbortController();
    setFetchAbort(controller);

    try {
      // Check for existing messages (incremental pull)
      const latest = await getLatestTimestamp(selectedConvo.id);
      const existing = latest != null;
      setIsIncremental(existing);
      if (existing) {
        const stored = await getMessagesForConvo(selectedConvo.id);
        setExistingCount(stored.length);
        setFetchedMsgs(stored.map(storedMsgToView));
      } else {
        setFetchedMsgs([]);
      }

      // Build the set of already-stored message IDs for early stopping
      const storedIds = existing
        ? new Set(
            (await getMessagesForConvo(selectedConvo.id)).map((m) => {
              const parts = m.id.split(":");
              return parts[parts.length - 1];
            }),
          )
        : new Set<string>();

      const before = timeRangeToDate(timeRange, customDays);

      const msgs = await fetchMessages(a, selectedConvo.id, {
        before,
        signal: controller.signal,
        onProgress(p) {
          setFetchProgress(p.done ? p : { ...p });
        },
        stopWhen(ids) {
          // Stop early if we've reached messages we already have
          return ids.some((id) => storedIds.has(id));
        },
      });

      if (existing) {
        setFetchedMsgs((prev) => [...prev, ...msgs]);
      } else {
        setFetchedMsgs(msgs);
      }

      if (msgs.length > 0) {
        await storeMessages(
          msgs.map((m) => ({
            id: `${selectedConvo.id}:${m.id}`,
            convoId: selectedConvo.id,
            text: m.text,
            senderDid: m.senderDid,
            senderHandle: m.senderHandle,
            senderDisplayName: m.senderDisplayName,
            sentAt: m.sentAt,
            replyTo: m.replyTo ? `${selectedConvo.id}:${m.replyTo}` : undefined,
          })),
        );
      }
    } catch (e: unknown) {
      if ((e as Error)?.name === "AbortError") return;
      setError((e as Error)?.message ?? "Failed to fetch messages");
    } finally {
      setFetching(false);
      setFetchAbort(null);
    }
  }

  function storedMsgToView(m: StoredMessage): MessageView {
    const parts = m.id.split(":");
    return {
      id: parts[parts.length - 1],
      rev: "",
      text: m.text,
      senderDid: m.senderDid,
      senderHandle: m.senderHandle ?? "",
      sentAt: m.sentAt,
      replyTo: m.replyTo,
    };
  }

  function cancelFetch() {
    fetchAbort?.abort();
  }

  // --- Embed ---
  function startEmbedding() {
    if (!selectedConvo) return;
    setEmbedding(true);
    setEmbedProgress(null);
    setError(null);

    terminateWorker();

    const worker = new Worker(
      new URL("./embed.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;

    // Get messages from IndexedDB (they may include previously stored ones)
    getMessagesForConvo(selectedConvo.id).then(async (stored) => {
      const toEmbed = stored.filter(
        (m) => !m.embedding && m.text.trim().length > 0,
      );

      if (toEmbed.length === 0) {
        setEmbedding(false);
        setPhase("cluster");
        return;
      }

      setEmbedProgress({ done: 0, total: toEmbed.length });

      const batchSize = 100;
      let embedded = 0;

      for (let i = 0; i < toEmbed.length; i += batchSize) {
        const batch = toEmbed.slice(i, i + batchSize);

        const result = await new Promise<{ id: number; embeddings: number[][] }>(
          (resolve, reject) => {
            const handler = (e: MessageEvent) => {
              if (e.data.type === "embeddings" && e.data.id === i) {
                worker.removeEventListener("message", handler);
                resolve(e.data);
              }
              if (e.data.type === "error" && e.data.id === i) {
                worker.removeEventListener("message", handler);
                reject(new Error(e.data.message));
              }
            };
            worker.addEventListener("message", handler);
            worker.postMessage({
              type: "embed",
              id: i,
              texts: batch.map((m) => m.text),
            });
          },
        );

        // Store embeddings
        const updates = batch.map((m, j) => ({
          id: m.id,
          embedding: result.embeddings[j],
        }));
        await storeEmbeddings(updates);

        embedded += batch.length;
        setEmbedProgress({ done: embedded, total: toEmbed.length });
      }

      setEmbedding(false);
      setPhase("cluster");
    });
  }

  function terminateWorker() {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
  }

  // --- Cluster ---
  async function startClustering() {
    if (!selectedConvo) return;
    setClustering(true);
    setError(null);

    try {
      // Dynamic import to avoid loading cluster code until needed
      const { clusterMessages } = await import("./cluster.ts");
      const msgs = await getMessagesForConvo(selectedConvo.id);
      const embedded = msgs.filter(
        (m) => m.embedding && m.embedding.length > 0,
      );

      const result = clusterMessages(embedded);

      setClusterResult(result);
    } catch (e: unknown) {
      setError((e as Error)?.message ?? "Clustering failed");
    } finally {
      setClustering(false);
    }
  }

  // --- Helpers ---
  function isGroup(convo: ConvoSummary): boolean {
    return convo.kind === "group";
  }

  function groupName(convo: ConvoSummary): string {
    if (convo.groupName) return convo.groupName;
    if (!isGroup(convo) && convo.members.length >= 2) {
      // DM: show the other person's name
      const other = convo.members.find((m) => m.did !== a?.session?.did);
      return other?.displayName || other?.handle || "Direct Message";
    }
    return "Unnamed Group";
  }

  function memberCount(convo: ConvoSummary): number {
    return convo.memberCount ?? convo.members.length;
  }

  // --- Loading ---
  if (state === "loading") {
    return (
      <main>
        <div class="container">
          <h1>Bluesky Chat Mapper</h1>
          <p class="loading">Initializing…</p>
        </div>
      </main>
    );
  }

  // --- Login ---
  if (state === "login") {
    return (
      <main>
        <div class="container login-container">
          <div class="logo">
            <svg viewBox="0 0 48 48" width="48" height="48">
              <circle cx="24" cy="14" r="6" fill="#4a9eff" opacity="0.9"/>
              <circle cx="14" cy="32" r="5" fill="#7c5cfc" opacity="0.8"/>
              <circle cx="34" cy="32" r="7" fill="#4a9eff" opacity="0.9"/>
              <line x1="24" y1="20" x2="17" y2="28" stroke="#6b7b8d" stroke-width="2"/>
              <line x1="24" y1="20" x2="32" y2="26" stroke="#6b7b8d" stroke-width="2"/>
              <line x1="17" y1="35" x2="28" y2="36" stroke="#6b7b8d" stroke-width="2"/>
            </svg>
          </div>
          <h1>Bluesky Chat Mapper</h1>
          <p class="subtitle">
            Visualize your group chats as interactive mindmaps.
          </p>

          <form onSubmit={handleLogin}>
            <label for="handle-input">Bluesky Handle</label>
            <input
              id="handle-input"
              type="text"
              placeholder="e.g. alice.bsky.social"
              value={handle}
              onInput={(e) => setHandle(e.currentTarget.value)}
              autofocus
            />

            <label for="password-input">
              Password{" "}
              <span class="hint">(app passwords don't work for chat)</span>
            </label>
            <input
              id="password-input"
              type="password"
              placeholder="Your Bluesky password"
              value={appPassword}
              onInput={(e) => setAppPassword(e.currentTarget.value)}
            />

            <label for="pds-input">
              PDS URL{" "}
              <span class="hint">(for private servers; default is bsky.social)</span>
            </label>
            <input
              id="pds-input"
              type="text"
              placeholder="https://bsky.social"
              value={pdsUrl}
              onInput={(e) => setPdsUrl(e.currentTarget.value)}
            />

            <button type="submit">Sign in</button>
          </form>

          {error && <p class="error">{error}</p>}

          <p class="footer-note">
            This is a static web app — your credentials go directly to your
            PDS. Nothing leaves your browser.
          </p>
        </div>
      </main>
    );
  }

  // --- Chat Picker ---
  if (state === "picker") {
    return (
      <main>
        <header>
          <h1>Bluesky Chat Mapper</h1>
          <button class="logout-btn" onClick={handleLogout}>
            Log out
          </button>
        </header>

        <div class="container">
          <h2>Select a chat</h2>

          {loadingConvos && <p class="loading">Loading conversations…</p>}

          {error && <p class="error">{error}</p>}

          {!loadingConvos && !error && convos.length === 0 && (
            <p class="empty">No conversations found.</p>
          )}

          <ul class="convo-list">
            {convos.map((convo) => (
              <li
                key={convo.id}
                class={`convo-item ${isGroup(convo) ? "group" : "dm"}`}
                onClick={() => selectConvo(convo)}
              >
                <div class="convo-header">
                  <span class="convo-name">{groupName(convo)}</span>
                  <span class="convo-badge">
                    ({isGroup(convo) ? "group" : "dm"}, {memberCount(convo)})
                  </span>
                </div>
                {convo.lastMessage && (
                  <p class="convo-preview">
                    {convo.lastMessage.text.slice(0, 120)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      </main>
    );
  }

  // --- Processing view (fetch → embed → cluster) ---
  const phaseLabels: Record<Phase, string> = {
    fetch: "① Pull",
    embed: "② Embed",
    cluster: "③ Cluster",
    done: "Done ✅",
  };
  const phaseDots: Record<Phase, string> = {
    fetch: "1",
    embed: "2",
    cluster: "3",
    done: "✓",
  };

  const fetchDone = fetchProgress?.done && fetchedMsgs.length > 0;
  const embedDone = phase === "cluster" || phase === "done";
  const clusterDone = phase === "done" || clusterResult != null;

  // --- Graph view ---
  if (state === "graph" && clusterResult) {
    return (
      <main class="graph-view">
        <header>
          <h1>Bluesky Chat Mapper</h1>
          <button class="logout-btn" onClick={handleLogout}>
            Log out
          </button>
        </header>

        <Graph
          result={clusterResult}
          convoId={selectedConvo!.id}
          onBack={() => setState("processing")}
        />
      </main>
    );
  }

  return (
    <main>
      <header>
        <h1>Bluesky Chat Mapper</h1>
        <button class="logout-btn" onClick={handleLogout}>
          Log out
        </button>
      </header>

      <div class="container fetching-container">
        <button class="back-btn" onClick={backToPicker}>
          ← Back to chats
        </button>

        <h2>{groupName(selectedConvo!)}</h2>
        <p class="fetch-meta">{memberCount(selectedConvo!)} members</p>

        {/* Auto-start the current phase (runs once per phase) */}
        {(() => {
          if (!autoStartedRef.current.has(phase)) {
            autoStartedRef.current.add(phase);
            if (phase === "embed") setTimeout(startEmbedding, 50);
            else if (phase === "cluster") setTimeout(startClustering, 50);
          }
          return null;
        })()}

        {/* Phase stepper */}
        <div class="phase-stepper">
          {(["fetch", "embed", "cluster"] as Phase[]).map((p) => {
            let className = "phase-step";
            if (p === phase) className += " active";
            else if (
              (p === "fetch" && fetchDone) ||
              (p === "embed" && embedDone) ||
              (p === "cluster" && clusterDone)
            ) {
              className += " done";
            }
            return (
              <div class={className}>
                <span class="phase-dot">{phaseDots[p]}</span>
                <span class="phase-label-mini">{phaseLabels[p]}</span>
              </div>
            );
          })}
        </div>

        {error && <p class="error">{error}</p>}

        {/* --- Time filter (always visible until fetch starts) --- */}
        {!fetching && !fetchDone && (
          <div class="time-filter">
            <label for="time-range">Time range:</label>
            <select
              id="time-range"
              value={timeRange}
              onChange={(e) => setTimeRange(e.currentTarget.value as TimeRange)}
            >
              <option value="all">All time</option>
              <option value="7d">Last 7 days</option>
              <option value="1m">Last month</option>
              <option value="3m">Last 3 months</option>
              <option value="6m">Last 6 months</option>
              <option value="12m">Last year</option>
              <option value="custom">Custom…</option>
            </select>

            {timeRange === "custom" && (
              <label class="custom-days">
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={customDays}
                  onChange={(e) => setCustomDays(Number(e.currentTarget.value) || 30)}
                  class="custom-days-input"
                />
                days
              </label>
            )}

            {!userStarted && !fetching && !fetchProgress && (
              <button class="fetch-btn" onClick={startFetch}>
                Start
              </button>
            )}
          </div>
        )}

        {/* --- Step 1: Pull — always visible after user clicks Start --- */}
        {userStarted && (
          <div class="step-section">
            <h3 class="step-header">
              <span class={phase === "fetch" ? "step-dot active" : fetchDone ? "step-dot done" : "step-dot"}>1</span>
              Pull messages
              {fetchDone && <span class="step-check">✅</span>}
              {fetching && !fetchDone && <span class="step-status">Running…</span>}
            </h3>
            {fetching && (
              <button class="cancel-btn" onClick={cancelFetch}>
                Cancel
              </button>
            )}
            {fetchProgress && (
              <div class="progress-section">
                <div class="progress-bar">
                  <div
                    class="progress-fill"
                    style={{
                      width: fetchProgress.done
                        ? "100%"
                        : `${Math.min((fetchProgress.fetched / 5000) * 100, 95)}%`,
                    }}
                  />
                </div>
                <p class="progress-text">
                  {fetchProgress.done ? "✅" : "📥"}{" "}
                  {fetchProgress.fetched} new
                  {isIncremental && ` (+${existingCount} existing)`}{" "}
                  messages
                  {fetchProgress.oldestDate && (
                    <span>
                      {" "}
                      · oldest:{" "}
                      {new Date(fetchProgress.oldestDate).toLocaleDateString()}
                    </span>
                  )}
                </p>
              </div>
            )}
            {fetchDone && fetchedMsgs.length === 0 && (
              <p class="empty">No messages in this time range.</p>
            )}
          </div>
        )}

        {/* --- Step 2: Embed — always visible after fetch done --- */}
        {fetchDone && (
          <div class="step-section">
            <h3 class="step-header">
              <span class={phase === "embed" ? "step-dot active" : embedDone ? "step-dot done" : "step-dot"}>2</span>
              Generate embeddings
              {!embedding && embedDone && <span class="step-check">✅</span>}
              {embedding && <span class="step-status">Running…</span>}
            </h3>
            {embedProgress && (
              <div class="progress-section">
                <div class="progress-bar">
                  <div
                    class="progress-fill"
                    style={{
                      width: `${(embedProgress.done / embedProgress.total) * 100}%`,
                    }}
                  />
                </div>
                <p class="progress-text">
                  {embedding ? "🧠" : "✅"} {embedProgress.done} /{" "}
                  {embedProgress.total} messages embedded
                </p>
              </div>
            )}
          </div>
        )}

        {/* --- Step 3: Cluster — always visible after embed done --- */}
        {embedDone && (
          <div class="step-section">
            <h3 class="step-header">
              <span class={phase === "cluster" ? "step-dot active" : clusterDone ? "step-dot done" : "step-dot"}>3</span>
              Cluster messages
              {!clustering && clusterDone && <span class="step-check">✅</span>}
              {clustering && <span class="step-status">Running…</span>}
            </h3>
            {clustering && (
              <div class="progress-section">
                <div class="progress-bar indeterminate">
                  <div class="progress-fill" />
                </div>
                <p class="progress-text">🔍 Grouping messages into topics…</p>
              </div>
            )}
          </div>
        )}

        {/* --- Results --- */}
        {clusterResult && clusterResult.clusters.length > 0 && (
          <div class="cluster-results">
            <p class="summary-count">
              ✅ {clusterResult.clusters.length} topic clusters
              {" · "}
              {clusterResult.clusters.reduce((s, c) => s + c.size, 0)}{" "}
              messages grouped
            </p>

            <ul class="cluster-list">
              {clusterResult.clusters.slice(0, 20).map((c) => (
                <li key={c.id} class="cluster-item">
                  <div class="cluster-header">
                    <span class="cluster-label">{c.label}</span>
                    <span class="cluster-size">{c.size} msgs</span>
                  </div>
                  <div
                    class="cluster-bar"
                    style={{
                      width: `${Math.min((c.size / clusterResult.clusters[0].size) * 100, 100)}%`,
                    }}
                  />
                </li>
              ))}
            </ul>

            <button
              class="generate-btn"
              onClick={() => setState("graph")}
            >
              Generate Map
            </button>

            <MessageSearch convoId={selectedConvo!.id} />
          </div>
        )}

        {clusterResult && clusterResult.clusters.length === 0 && (
          <p class="empty">
            No clusters found. Try fetching more messages first.
          </p>
        )}
      </div>
    </main>
  );
}
