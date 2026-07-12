# Bluesky Chat Mapper — Static Web App

A static web app that connects to Bluesky via password auth, pulls a single group chat's history, generates semantic embeddings client-side with Ternlight WASM, and renders an interactive mindmap of the conversation.

No backend. No API keys. No server.

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Static files (Vercel / Cloudflare Pages)          │
│                                                    │
│  public/client-metadata.json    ← OAuth metadata   │
│  src/                                            │
│    auth.ts        ← createSession + proxy header    │
│    api.ts         ← ATProto chat fetching          │
│    db.ts          ← IndexedDB wrapper              │
│    embed.ts       ← Ternlight WASM worker          │
│    cluster.ts     ← Cosine sim + clustering        │
│    graph.ts       ← D3 force-directed mindmap       │
│    App.tsx        ← UI shell                       │
│                                                    │
│  User flow:                                        │
│  1. Visit site → enter handle + password            │
│  2. List group chats → pick one                    │
│  3. Set time filter (e.g. last 3 months)           │
│  4. "Generate Map" → pull → embed → render         │
└──────────────────────────────────────────────────┘
```

## Key Libraries

| Purpose | Package | Size |
|---|---|---|
| Auth | `@atproto/api` (AtpAgent) | bundled |
| API | `@atproto/api` | bundled |
| Embeddings | `@ternlight/mini` | 5.5MB WASM |
| Graph | `d3-force`, `d3-selection` | ~30KB |
| DB | `idb` (IndexedDB wrapper) | ~2KB |
| Framework | Preact (~3KB) or vanilla | ~3KB |

## Phases

### Phase 1 — Auth + chat picker ✅

- `client-metadata.json` deployed at root
- ~~OAuth login flow (PKCE + DPoP via Web Crypto API)~~
- **Actually implemented: createSession (full password) auth** — see findings below
- Fetch convo list, display names + member counts
- User picks one
- Deployed at https://riziles.github.io/bsky-chat-mapper/

### Phase 2 — Pull + store ✅

- Time filter UI (preset: 1/3/6/12 months, or custom date range)
- Paginated fetch with progress bar
- Cancel support via AbortController
- Store messages in IndexedDB keyed by `convoId`
- Summary view with message count, date range, Generate Map stub
- Tested: 2,858 messages from a 50-member group in ~10 seconds

### Phase 3 — Embed + cluster ✅

- Web Worker loads Ternlight WASM dynamically (`@ternlight/mini`: 5MB gzipped)
- Batch embeds with progress (2,751 messages in ~20s)
- Stores vectors back into IndexedDB
- Flat greedy clustering with cosine similarity threshold (0.65)
- Labels clusters by most frequent bigrams
- 3-step UI stepper: Pull → Embed → Cluster
- Tested: 40 topic clusters from 2,751 messages

### Phase 3.5 — Temporal + reply chain awareness ✅

- Reply chains (replyTo field) resolved via Union-Find into forced same-cluster groups
- Chronological proximity based on message position index, not wall-clock time
- \( \text{proximity} = 0.5^{|pos_i - pos_j| / 10} \) — adjacent messages always get 1.0
- Combined score: \( 0.7 \times \text{cosine} + 0.3 \times \text{chronoProximity} \)
- Min similarity threshold: 0.4 (chronological component boosts it)

### Phase 4 — Mindmap + search

- D3 force simulation: clusters as nodes, similarity as edges
- Node size = message count, proximity = semantic similarity
- Click cluster → see representative messages
- Vector search bar: type query → embed → highlight nearest nodes

## Data Model

```ts
// IndexedDB stores

interface Message {
  id: string
  text: string
  senderDid: string
  sentAt: string
  embedding?: Float32Array  // added in Phase 3
}

interface TopicCluster {
  id: string
  label: string             // most frequent n-grams
  messages: string[]        // message IDs
  centroid: Float32Array    // mean embedding
}
```

## Phase 1 Findings

### OAuth abandoned for now

- OAuth tokens (DPoP-bound) were rejected by the Bluesky PDS for chat proxying (401/403)
- The PDS host `scalycap.us-west.host.bsky.network` requires `com.atproto.access` scope for `atproto-proxy: did:web:api.bsky.chat#bsky_chat`
- App passwords produce `com.atproto.appPass` scope — also rejected ("Bad token method")
- Full password `createSession` produces `com.atproto.access` scope — works
- OAuth may work on other PDS instances; worth revisiting later

### Chat routing

- Chat endpoints must go through the PDS with `atproto-proxy: did:web:api.bsky.chat#bsky_chat`
- Direct calls to `api.bsky.app` or `bsky.social` don't work for chat
- The `configureProxy()` method on AtpAgent adds the header globally; PDS ignores it for non-chat endpoints

### Session persistence

- Session stored in localStorage (`bsky-chat-mapper-session` key)
- `AtpAgent.resumeSession()` restores session on page reload
- Refresh tokens last ~90 days

## Rate Limit Math

Bluesky allows 3,000 requests per 5-minute window.

- 100 messages per page
- 30 pages = 3,000 messages in 5 minutes
- A chat with 10 messages/day over 6 months = ~1,800 messages
- Pulls in under 3 minutes

Single chat only — no multi-chat rate concerns.

## Constraints

| Concern | Mitigation |
|---|---|
| Ternlight WASM download | 5.5MB, cached by browser on first visit |
| Embedding throughput | ~2ms/msg; 5,000 msgs = ~10s in Web Worker |
| Memory | 384-dim × 5,000 messages ≈ 7.6MB (Float32) |
| OAuth client_id | One-time deploy of `client-metadata.json` to HTTPS host |

## Deployment

Any static host works:

- **Vercel**: `vercel deploy`
- **Cloudflare Pages**: `wrangler pages deploy`
- **GitHub Pages**: push to `gh-pages` branch

One-time setup: place `client-metadata.json` in the public root with the deployed URL as `client_id`.

---

