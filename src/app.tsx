import { useState, useEffect } from "preact/hooks";
import { login, logout, tryRestoreSession } from "./auth.ts";
import {
  listConvos,
  fetchMessages,
  type ConvoSummary,
  type FetchProgress,
  type MessageView,
} from "./api.ts";
import { storeMessages } from "./db.ts";
import type { AtpAgent } from "@atproto/api";
import "./app.css";

type AppState = "loading" | "login" | "picker" | "fetching";

type TimeRange = "all" | "1m" | "3m" | "6m" | "12m";

function timeRangeToDate(range: TimeRange): Date | undefined {
  if (range === "all") return undefined;
  const months: Record<string, number> = { "1m": 1, "3m": 3, "6m": 6, "12m": 12 };
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

  // Fetching state
  const [selectedConvo, setSelectedConvo] = useState<ConvoSummary | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [fetching, setFetching] = useState(false);
  const [fetchProgress, setFetchProgress] = useState<FetchProgress | null>(null);
  const [fetchedMsgs, setFetchedMsgs] = useState<MessageView[]>([]);
  const [fetchAbort, setFetchAbort] = useState<AbortController | null>(null);

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
    setTimeRange("all");
    setFetching(false);
    setFetchProgress(null);
    setFetchedMsgs([]);
    setError(null);
    setState("fetching");
  }

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

      // Store in IndexedDB
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

  function backToPicker() {
    setState("picker");
    setSelectedConvo(null);
    loadConvos(a!);
  }

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

  // --- Fetching view ---
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
        <p class="fetch-meta">
          👥 {memberCount(selectedConvo!)} members
        </p>

        {/* Time filter */}
        <div class="time-filter">
          <label for="time-range">Time range:</label>
          <select
            id="time-range"
            value={timeRange}
            onChange={(e) =>
              setTimeRange(e.currentTarget.value as TimeRange)
            }
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

        {error && <p class="error">{error}</p>}

        {/* Progress */}
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
              {fetchProgress.fetched} messages fetched
              {fetchProgress.oldestDate && (
                <span>
                  {" "}
                  · oldest:{" "}
                  {new Date(fetchProgress.oldestDate).toLocaleDateString()}
                </span>
              )}
              {fetchProgress.done && " · Done!"}
            </p>
          </div>
        )}

        {/* Summary after fetch */}
        {fetchProgress?.done && fetchedMsgs.length > 0 && (
          <div class="fetch-summary">
            <p class="summary-count">
              ✅ {fetchedMsgs.length} messages stored
            </p>
            <p class="summary-range">
              {fetchedMsgs.length > 0 && (
                <span>
                  {new Date(fetchedMsgs[fetchedMsgs.length - 1].sentAt).toLocaleDateString()} —{" "}
                  {new Date(fetchedMsgs[0].sentAt).toLocaleDateString()}
                </span>
              )}
            </p>
            <button
              class="generate-btn"
              onClick={() => alert("Phase 3 coming soon!")}
            >
              Generate Map
            </button>
          </div>
        )}

        {fetchProgress?.done && fetchedMsgs.length === 0 && !error && (
          <p class="empty">
            No messages in this time range.
          </p>
        )}
      </div>
    </main>
  );
}
