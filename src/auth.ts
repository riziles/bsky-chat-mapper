import { AtpAgent, type AtpSessionData } from "@atproto/api";

let agent: AtpAgent | null = null;

const PROXY_HEADER = "did:web:api.bsky.chat#bsky_chat";
const SESSION_KEY = "bsky-chat-mapper-session";

function createAgentWithProxy(): AtpAgent {
  const a = new AtpAgent({ service: "https://bsky.social" });
  a.configureProxy(PROXY_HEADER);
  return a;
}

export async function login(
  identifier: string,
  password: string,
): Promise<AtpAgent> {
  agent = createAgentWithProxy();
  await agent.login({ identifier, password });
  persistSession();
  return agent;
}

export async function resumeSession(
  session: AtpSessionData,
): Promise<AtpAgent | null> {
  try {
    agent = createAgentWithProxy();
    const result = await agent.resumeSession(session);
    if (result.success) {
      persistSession();
      return agent;
    }
    agent = null;
    return null;
  } catch {
    agent = null;
    return null;
  }
}

/** Try to restore a session from localStorage */
export async function tryRestoreSession(): Promise<AtpAgent | null> {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session: AtpSessionData = JSON.parse(raw);
    return resumeSession(session);
  } catch {
    return null;
  }
}

function persistSession(): void {
  if (!agent?.session) return;
  localStorage.setItem(SESSION_KEY, JSON.stringify(agent.session));
}

export function getAgent(): AtpAgent | null {
  return agent;
}

export function logout(): void {
  localStorage.removeItem(SESSION_KEY);
  agent = null;
}
