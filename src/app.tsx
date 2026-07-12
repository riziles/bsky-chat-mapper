import { useState, useEffect } from "preact/hooks";
import { login, logout, tryRestoreSession } from "./auth.ts";
import { listConvos, type ConvoSummary } from "./api.ts";
import type { AtpAgent } from "@atproto/api";
import "./app.css";

type AppState = "loading" | "login" | "picker";

export function App() {
  const [state, setState] = useState<AppState>("loading");
  const [handle, setHandle] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [, setAgent] = useState<AtpAgent | null>(null);
  const [convos, setConvos] = useState<ConvoSummary[]>([]);
  const [loadingConvos, setLoadingConvos] = useState(false);

  // Try to restore a session if one exists
  useEffect(() => {
    tryRestoreSession().then((a) => {
      if (a) {
        setAgent(a);
        setState("picker");
        loadConvos(a);
      } else {
        setState("login");
      }
    });
  }, []);

  async function loadConvos(a: AtpAgent) {
    setLoadingConvos(true);
    setError(null);
    try {
      const list = await listConvos(a);
      setConvos(list);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load conversations");
    } finally {
      setLoadingConvos(false);
    }
  }

  async function handleLogin(e: Event) {
    e.preventDefault();
    if (!handle.trim() || !appPassword.trim()) return;
    setError(null);
    try {
      const a = await login(handle.trim(), appPassword.trim());
      setAgent(a);
      setState("picker");
      loadConvos(a);
    } catch (e: any) {
      setError(e?.message ?? "Login failed");
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
              <span class="hint">
                (app passwords don't work for chat)
              </span>
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
            Your credentials are only sent to Bluesky. Nothing is stored on our servers.
          </p>
        </div>
      </main>
    );
  }

  // --- Chat Picker ---
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
              onClick={() => alert("Phase 2 coming soon!")}
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
