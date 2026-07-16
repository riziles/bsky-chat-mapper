# Bluesky Chat Mapper

A static web app that pulls your Bluesky group chat history, generates semantic embeddings client-side, clusters messages by topic, and renders an interactive force-directed mindmap.

**No backend. No API keys. No server.**

## Features

- **Full password auth** with custom PDS URL support (private servers)
- **Incremental message pulling** with configurable time filters
- **On-device semantic embeddings** via [Ternlight](https://github.com/tern-light/ternlight) (runs entirely in your browser)
- **TF-IDF topic clustering** with chronological proximity and reply-chain awareness
- **Interactive D3 force graph** with draggable nodes, zoom, and cluster search
- **Timeline minimap** — stacked colored bars showing message density over time; clickable to select clusters
- **Three view modes**: Force Graph, Timeline, or None (sidebar-only)
- **Multi-select** — click multiple clusters to compare topics side-by-side
- **Compose + reply** — send messages directly, reply to any message in the sidebar
- **Poster filter** — autocomplete dropdown to filter by sender, with keyboard navigation
- **Dual-mode search**: semantic (meaning-based) and fuzzy text (typo-tolerant) via [MiniSearch](https://github.com/lucaong/minisearch)
- **IndexedDB persistence** — subsequent visits only pull new messages

## Quick Start

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm build      # production build → dist/
pnpm deploy     # pushes dist/ to gh-pages branch
```

## Architecture

```
src/
  auth.ts        ← createSession auth + atproto-proxy header for chat
  api.ts         ← ATProto chat fetching (listConvos, getMessages)
  db.ts          ← IndexedDB wrapper (idb)
  cluster.ts     ← TF-IDF clustering + reply chains
  embed.worker.ts← Ternlight WASM embedding worker
  graph.tsx      ← D3 force-directed graph component
  search.tsx     ← Dual-mode search (semantic + fuzzy)
  app.tsx        ← UI shell
  utils.ts       ← Safe text utilities
```

## Stack

| Layer           | Choice                                           |
| --------------- | ------------------------------------------------ |
| Framework       | Preact 10 + TypeScript                           |
| Bundler         | Vite 8                                           |
| Auth            | `@atproto/api` (AtpAgent + createSession)        |
| Embeddings      | `@ternlight/mini` (WASM)                         |
| Search          | `minisearch` (fuzzy)                             |
| Graph           | `d3-force`, `d3-selection`, `d3-zoom`, `d3-drag` |
| DB              | `idb` (IndexedDB)                                |
| Deployment      | GitHub Pages via `gh-pages`                      |
| Package manager | pnpm                                             |

## Deployment

Any static host works. One-time setup: place `client-metadata.json` in `public/` with the deployed URL.

```bash
pnpm deploy   # build + push to gh-pages
```

## License

MIT — see [LICENSE](LICENSE).

## Ideas / TODO

- [x] **Conversation minimap** — compact timeline strip showing message density over time, color-coded by cluster
- [ ] **2D message scatter** — PCA or force-directed reduction of 384-dim embeddings to plot every message as a dot in semantic space
- [ ] **Reaction heatmap** — aggregate 👍👎😂 etc. per cluster or per poster
- [ ] **Co-occurrence graph** — edges between posters who reply to each other frequently
- [ ] **Sentiment arc** — per-cluster sentiment trend line over the conversation timeline
- [ ] **Topic drift animation** — animate cluster sizes changing as the conversation progresses
- [ ] **Word cloud per cluster** — replace/in addition to TF-IDF labels
- [ ] **Export to Markdown / JSON / CSV** — dump filtered results for offline analysis
- [ ] **Nightly recursive summarization** — (requires LLM on-device, maybe WebGPU someday) recursive topic summaries à la RAPTOR
- [ ] **Message similarity explorer** — click a message, see its N nearest neighbors across all clusters
- [ ] **Compare two convos** — load and align two different chats side-by-side
- [ ] **PWA/offline mode** — service worker caching for full offline use
