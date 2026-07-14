# Architecture Deep-Dive

A static web app that connects to Bluesky via password auth, pulls a single group chat's history, generates semantic embeddings client-side with Ternlight WASM, and renders an interactive force-directed mindmap.

**No backend. No API keys. No server.**

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Static files (GitHub Pages)                        │
│                                                     │
│  src/                                               │
│    auth.ts        ← createSession + proxy header    │
│    api.ts         ← ATProto chat fetching           │
│    db.ts          ← IndexedDB wrapper               │
│    embed.worker.ts← Ternlight WASM embedding worker │
│    cluster.ts     ← TF-IDF clustering + reply chains│
│    graph.tsx      ← D3 force-directed mindmap       │
│    search.tsx     ← Dual-mode search (semantic +    │
│                      fuzzy via MiniSearch)          │
│    app.tsx        ← UI shell                        │
│    utils.ts       ← Safe text utilities             │
│                                                     │
│  public/                                            │
│    client-metadata.json  ← OAuth metadata           │
│    favicon.svg                                      │
│                                                     │
│  User flow:                                         │
│  1. Visit site → enter handle + password + PDS URL  │
│  2. List group chats → pick one                     │
│  3. Set time filter (default 7 days)                │
│  4. Click Start → pull → embed → cluster → map      │
└─────────────────────────────────────────────────────┘
```

## Key Libraries

| Purpose      | Package                                          | Size         |
| ------------ | ------------------------------------------------ | ------------ |
| Auth + API   | `@atproto/api` (AtpAgent)                        | bundled      |
| Embeddings   | `@ternlight/mini`                                | ~5MB WASM    |
| Fuzzy search | `minisearch`                                     | ~6KB gzipped |
| Graph        | `d3-force`, `d3-selection`, `d3-zoom`, `d3-drag` | ~30KB        |
| DB           | `idb` (IndexedDB wrapper)                        | ~2KB         |
| Framework    | Preact 10                                        | ~3KB         |

## Auth

### Why full password, not OAuth or app passwords

Bluesky Chat requires `com.atproto.access` scope tokens. Both OAuth (DPoP-bound)
and app passwords (`com.atproto.appPass`) produce insufficient scopes — the PDS
rejects them with 401/403. Full credentials via `createSession` produce the
required `access` scope.

### Proxy header

All chat endpoints must include `atproto-proxy: did:web:api.bsky.chat#bsky_chat`.
Without it, the PDS routes requests to the wrong service. The `configureProxy()`
method on AtpAgent adds this header globally; the PDS ignores it for non-chat
endpoints.

### Custom PDS support

Users on private PDS instances enter their server URL on the login form.
Defaults to `https://bsky.social`. The PDS URL persists in localStorage
alongside access/refresh tokens.

### Session persistence

- Stored in localStorage under `bsky-chat-mapper-session` key
- Format: `{ session: AtpSessionData, service: string }`
- `AtpAgent.resumeSession()` restores on page reload
- Refresh tokens last ~90 days

## Clustering

### TF-IDF labeling

Cluster labels use TF-IDF scoring on unigrams extracted from messages within
each cluster. Stop words are filtered; terms shorter than 3 characters are
discarded. IDF is computed as `log((N + 1) / (df + 1)) + 1` across all
clusters. The top 2 distinctive terms form the label.

### Reply chain awareness

Reply chains (via the `replyTo` field) are resolved with Union-Find into forced
same-cluster groups. Messages in the same reply thread are guaranteed to appear
in the same cluster.

### Chronological proximity

Instead of using wall-clock time, proximity is measured by message position
index (after sorting by `sentAt` ascending). Adjacent messages always get
proximity 1.0, regardless of how much real time passed between them.

Combined score: `0.7 × cosine_similarity + 0.3 × chronoProximity`

Chrono proximity: `0.5^(|pos_i - pos_j| / 10)` (half-life of 10 positions)

Min similarity threshold: 0.4

## Force Graph

D3 force simulation with:
- **Charge**: `-width × 0.35` (scales to viewport)
- **Link distance**: `80 - similarity × 40`
- **Collision**: radius + 6px padding
- **Bounding force**: clamps nodes to viewBox margins
- **Center force**: `strength(0.15)` pulls toward viewport center
- **Auto-fit**: simulation runs to completion, then `zoomIdentity` scales
  the graph to fill ~90% of viewport

### Search on the graph

- **Semantic mode**: embeds query with Ternlight, highlights top 5 clusters
  by cosine similarity to centroid
- **Fuzzy mode**: MiniSearch ranks all messages, maps hits back to their
  containing clusters for highlighting; shows message-level results in
  sidebar with timestamps and match terms
- Fuzziness slider: 0.0–0.4 (controls MiniSearch edit distance)

## Search (per-message)

Dual-mode search on the cluster results page:
- **Fuzzy text**: MiniSearch with typo tolerance, shows top 20 messages with
  match terms and relevance scores
- **Semantic**: embeds query with Ternlight, cosine similarity ranking of
  all stored message embeddings

## Data Model

```ts
interface StoredMessage {
  id: string            // "{convoId}:{messageId}"
  convoId: string
  text: string
  senderDid: string
  senderHandle?: string
  senderDisplayName?: string
  sentAt: string
  replyTo?: string
  embedding?: number[]  // 384-dim Float32 from Ternlight
}

interface TopicCluster {
  id: number
  label: string         // TF-IDF top 2 terms, e.g. "twitter / posts"
  messageIds: string[]
  size: number
  centroid: number[]    // mean of member embeddings
}
```

## Performance & Constraints

| Concern         | Detail                                                                |
| --------------- | --------------------------------------------------------------------- |
| Ternlight WASM  | ~5MB download, cached by browser after first visit                    |
| Embedding speed | ~2ms/msg in Web Worker; 3,000 msgs ≈ 6s                               |
| Memory          | 384-dim × 5,000 messages ≈ 7.6MB (Float32)                            |
| IndexedDB       | All messages + embeddings persisted; incremental pulls only fetch new |
| Rate limits     | 3,000 API req/5min; 100 msgs/page → 30 pages/min                      |
| Bundle          | ~160KB gzipped JS + WASM + D3 (~30KB)                                 |

## Deployment

`pnpm deploy` runs `vite build` then pushes `dist/` to the `gh-pages` branch.
GitHub Pages serves at `https://<user>.github.io/bsky-chat-mapper/`.

Any static host works (Vercel, Cloudflare Pages, Netlify). One-time setup:
place `client-metadata.json` in `public/` with the deployed URL as `client_id`.

## License

MIT — all dependencies (Ternlight, MiniSearch, D3, idb, Preact) are MIT or
ISC licensed and compatible.
