import type { AtpAgent } from "@atproto/api";

// Lightweight type mirrors for chat.convo operations
// (avoids deep imports that fail with pnpm strict module resolution)
export interface ConvoSummary {
  id: string;
  members: { did: string; handle?: string; displayName?: string }[];
  lastMessage?: { text: string; sentAt: string };
  unreadCount: number;
  // group-specific
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
                text:
                  (c.lastMessage as { text?: string }).text ?? "",
                sentAt:
                  (c.lastMessage as { sentAt?: string }).sentAt ?? "",
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
