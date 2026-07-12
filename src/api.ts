import type { AtpAgent } from "@atproto/api";

// Lightweight type mirrors for chat.convo operations
// (avoids deep imports that fail with pnpm strict module resolution)
export interface ConvoSummary {
  id: string;
  members: { did: string; handle?: string; displayName?: string }[];
  lastMessage?: { text: string; sentAt: string };
  unreadCount: number;
  kind?: "direct" | "group";
  groupName?: string;
  memberCount?: number;
}

export async function listConvos(agent: AtpAgent): Promise<ConvoSummary[]> {
  const convos: ConvoSummary[] = [];
  let cursor: string | undefined;

  do {
    const res = await agent.chat.bsky.convo.listConvos({
      cursor,
      limit: 100,
      status: "accepted",
    });
    for (const c of res.data.convos) {
      const isGroup = c.kind?.$type === "chat.bsky.convo.defs#groupConvo";
      const groupConvo = isGroup ? (c.kind as Record<string, unknown>) : null;
      convos.push({
        id: c.id,
        members: c.members?.map((m) => ({
          did: m.did,
          handle: m.handle,
          displayName: m.displayName,
        })) ?? [],
        lastMessage:
          c.lastMessage?.$type === "chat.bsky.convo.defs#messageView"
            ? {
                text: (c.lastMessage as { text?: string }).text ?? "",
                sentAt: (c.lastMessage as { sentAt?: string }).sentAt ?? "",
              }
            : undefined,
        unreadCount: c.unreadCount ?? 0,
        kind: isGroup ? "group" : "direct",
        groupName: groupConvo
          ? (groupConvo["name"] as string) ?? undefined
          : undefined,
        memberCount: groupConvo
          ? (groupConvo["memberCount"] as number) ?? undefined
          : c.members?.length,
      });
    }
    cursor = res.data.cursor;
  } while (cursor);

  return convos;
}

// --- Phase 2: Message fetching ---

export interface MessageView {
  id: string;
  rev: string;
  text: string;
  senderDid: string;
  sentAt: string;
  /** id of the message this is a reply to, if any */
  replyTo?: string;
  /** Sender profile if available from relatedProfiles */
  senderHandle?: string;
  senderDisplayName?: string;
}

export interface FetchProgress {
  fetched: number;
  oldestDate: string | null;
  done: boolean;
}

/**
 * Fetch messages for a convo, paginating backwards.
 * Calls onProgress after each page. Stops when messages are older than `before` (if set).
 */
export async function fetchMessages(
  agent: AtpAgent,
  convoId: string,
  opts: {
    before?: Date;
    onProgress: (p: FetchProgress) => void;
    signal?: AbortSignal;
  },
): Promise<MessageView[]> {
  const messages: MessageView[] = [];
  let cursor: string | undefined;
  const beforeTs = opts.before ? opts.before.toISOString() : null;

  while (true) {
    if (opts.signal?.aborted) break;

    const res = await agent.chat.bsky.convo.getMessages({
      convoId,
      cursor,
      limit: 100,
    });

    // Build a profile lookup from relatedProfiles
    const profileMap = new Map<string, { handle?: string; displayName?: string }>();
    for (const p of res.data.relatedProfiles ?? []) {
      profileMap.set(p.did, { handle: p.handle, displayName: p.displayName });
    }

    for (const m of res.data.messages) {
      // Only process MessageView (skip deleted, system messages for now)
      if (m.$type !== "chat.bsky.convo.defs#messageView") continue;

      const msg = m as unknown as {
        id: string;
        rev: string;
        text: string;
        sender: { did: string };
        sentAt: string;
        replyTo?: { messageId?: string };
      };

      // Stop if we've gone past the time cutoff
      if (beforeTs && msg.sentAt < beforeTs) {
        opts.onProgress({
          fetched: messages.length,
          oldestDate: messages.length > 0
            ? messages[messages.length - 1].sentAt
            : null,
          done: true,
        });
        return messages;
      }

      const profile = profileMap.get(msg.sender.did);
      messages.push({
        id: msg.id,
        rev: msg.rev,
        text: msg.text,
        senderDid: msg.sender.did,
        sentAt: msg.sentAt,
        replyTo: msg.replyTo?.messageId,
        senderHandle: profile?.handle,
        senderDisplayName: profile?.displayName,
      });
    }

    opts.onProgress({
      fetched: messages.length,
      oldestDate: messages.length > 0
        ? messages[messages.length - 1].sentAt
        : null,
      done: !res.data.cursor || (res.data.messages.length === 0),
    });

    cursor = res.data.cursor;
    if (!cursor || res.data.messages.length === 0) break;
  }

  opts.onProgress({
    fetched: messages.length,
    oldestDate: messages.length > 0
      ? messages[messages.length - 1].sentAt
      : null,
    done: true,
  });

  return messages;
}
