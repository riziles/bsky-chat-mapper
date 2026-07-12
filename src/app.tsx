import { useState, useEffect, useRef } from "preact/hooks";
import { login, logout, tryRestoreSession } from "./auth.ts";
import {
  listConvos,
  fetchMessages,
  type ConvoSummary,
  type FetchProgress,
  type MessageView,
} from "./api.ts";
import { storeMessages, storeEmbeddings, getMessagesForConvo } from "./db.ts";
import type { AtpAgent } from "@atproto/api";
import type { ClusterResult } from "./cluster.ts";
import "./app.css";

type AppState = "loading" | "login" | "picker" | "processing";

// Processing phases within the processing view
type Phase = "fetch" | "embed" | "cluster" | "done";

type TimeRange = "all" | "1m" | "3m" | "6m" | "12m";

function timeRangeToDate(range: TimeRange): Date | undefined {
  if (range === "all") return undefined;
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
  const [error, setError] = useState<string | null>(null);
  const [a, setAgent] = useState<AtpAgent | null>(null);
  const [convos, setConvos] = useState<ConvoSummary[]>([]);
  const [loadingConvos, setLoadingConvos] = useState(false);

  // Processing state
  const [selectedConvo, setSelectedConvo] = useState<ConvoSummary | null>(null);
  const [phase, setPhase] = useState<Phase>("fetch");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
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
      const agent = await login(handle.trim(), appPassword.trim());
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
    setState("login");
  }

  function selectConvo(convo: ConvoSummary) {
    setSelectedConvo(convo);
    setPhase("fetch");
    setTimeRange("all");
    setFetching(false);
    setFetchProgress(null);
    setFetchedMsgs([]);
    setEmbedding(false);
    setEmbedProgress(null);
    setClustering(false);
    setClusterResult(null);
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
    setFetching(true);
    setError(null);
    setFetchProgress({ fetched: 0, oldestDate: null, done: false });
    setFetchedMsgs([]);

    const controller = new AbortController();
    setFetchAbort(controller);

    try {
      const msgs = await fetchMessages(a, selectedConvo.id, {
        before: timeRangeToDate(timeRange),
        signal: controller.signal,
        onProgress(p) {
          setFetchProgress(p.done ? p : { ...p });
        },
      });

      setFetchedMsgs(msgs);

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
    return convo.groupName || "Unnamed Group";
  }

  function memberCount(convo: ConvoSummary): number {
    return convo.memberCount ?? convo.members.length;
  }

  // --- Loading ---
  if (state === "loading") {
    return (
      <main>
        <div class="container">
          <h1>🦋 Bluesky Chat Mapper</h1>
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
          <div class="logo">🦋</div>
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

            <button type="submit">Sign in</button>
          </form>

          {error && <p class="error">{error}</p>}

          <p class="footer-note">
            Your credentials are only sent to Bluesky. Nothing is stored on our
            servers.
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
          <h1>🦋 Bluesky Chat Mapper</h1>
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
                    {isGroup(convo) ? "👥" : "💬"} {memberCount(convo)}
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

  return (
    <main>
      <header>
        <h1>🦋 Bluesky Chat Mapper</h1>
        <button class="logout-btn" onClick={handleLogout}>
          Log out
        </button>
      </header>

      <div class="container fetching-container">
        <button class="back-btn" onClick={backToPicker}>
          ← Back to chats
        </button>

        <h2>{groupName(selectedConvo!)}</h2>
        <p class="fetch-meta">👥 {memberCount(selectedConvo!)} members</p>

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

        {/* --- Step 1: Fetch --- */}
        {phase === "fetch" && (
          <>
            <div class="time-filter">
              <label for="time-range">Time range:</label>
              <select
                id="time-range"
                value={timeRange}
                onChange={(e) => setTimeRange(e.currentTarget.value as TimeRange)}
                disabled={fetching}
              >
                <option value="all">All time</option>
                <option value="1m">Last month</option>
                <option value="3m">Last 3 months</option>
                <option value="6m">Last 6 months</option>
                <option value="12m">Last year</option>
              </select>

              {!fetching && (
                <button class="fetch-btn" onClick={startFetch}>
                  Fetch messages
                </button>
              )}
              {fetching && (
                <button class="cancel-btn" onClick={cancelFetch}>
                  Cancel
                </button>
              )}
            </div>

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
                  {fetchProgress.fetched} messages
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

            {fetchDone && (
              <div class="step-next">
                <button
                  class="step-btn"
                  onClick={() => setPhase("embed")}
                >
                  Next: Generate Embeddings →
                </button>
              </div>
            )}
          </>
        )}

        {/* --- Step 2: Embed --- */}
        {phase === "embed" && (
          <>
            <p class="phase-desc">
              Generating semantic embeddings for {fetchedMsgs.length} messages
              using on-device AI (runs entirely in your browser).
            </p>

            {!embedding && !embedDone && (
              <button class="step-btn" onClick={startEmbedding}>
                Generate Embeddings
              </button>
            )}

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

            {!embedding && embedDone && (
              <div class="step-next">
                <button
                  class="step-btn"
                  onClick={() => setPhase("cluster")}
                >
                  Next: Cluster Messages →
                </button>
              </div>
            )}
          </>
        )}

        {/* --- Step 3: Cluster --- */}
        {(phase === "cluster" || phase === "done") && (
          <>
            <p class="phase-desc">
              Group similar messages into topic clusters.
            </p>

            {!clustering && !clusterResult && (
              <button class="step-btn" onClick={startClustering}>
                Run Clustering
              </button>
            )}

            {clustering && (
              <div class="progress-section">
                <div class="progress-bar indeterminate">
                  <div class="progress-fill" />
                </div>
                <p class="progress-text">🔍 Grouping messages into topics…</p>
              </div>
            )}

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
                  onClick={() => alert("Phase 4 coming soon!")}
                >
                  Generate Map
                </button>
              </div>
            )}

            {clusterResult && clusterResult.clusters.length === 0 && (
              <p class="empty">
                No clusters found. Try fetching more messages first.
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
