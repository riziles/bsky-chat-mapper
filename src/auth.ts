import { AtpAgent, type AtpSessionData } from "@atproto/api";

let agent: AtpAgent | null = null;

const PROXY_HEADER = "did:web:api.bsky.chat#bsky_chat";
const SESSION_KEY = "bsky-chat-mapper-session";

function createAgentWithProxy(service: string): AtpAgent {
  const a = new AtpAgent({ service });
  a.configureProxy(PROXY_HEADER);
  return a;
}

export async function login(
  identifier: string,
  password: string,
  service = "https://bsky.social",
): Promise<AtpAgent> {
  agent = createAgentWithProxy(service);
  await agent.login({ identifier, password });
  persistSession(service);
  return agent;
}

export async function resumeSession(
  session: AtpSessionData,
  service = "https://bsky.social",
): Promise<AtpAgent | null> {
  try {
    agent = createAgentWithProxy(service);
    const result = await agent.resumeSession(session);
    if (result.success) {
      persistSession(service);
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
    const data = JSON.parse(raw);
    // Support both old format (plain session) and new format ({ session, service })
    const session: AtpSessionData = data.session ?? data;
    const service: string = data.service ?? "https://bsky.social";
    return resumeSession(session, service);
  } catch {
    return null;
  }
}

function persistSession(service: string): void {
  if (!agent?.session) return;
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    session: agent.session,
    service,
  }));
}

export function getAgent(): AtpAgent | null {
  return agent;
}

export function logout(): void {
  localStorage.removeItem(SESSION_KEY);
  agent = null;
}
