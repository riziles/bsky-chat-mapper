# 🦋 Bluesky Chat Mapper

A static web app that pulls a Bluesky group chat's history, generates semantic embeddings client-side, and renders an interactive mindmap of the conversation.

**No backend. No API keys. No server.**

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
  app.tsx        ← UI shell (login → chat picker → future phases)
  app.css        ← Dark-themed component styles
  index.css      ← CSS variables + global reset
  main.tsx       ← Preact entry point

public/
  client-metadata.json  ← OAuth metadata (kept for future OAuth option)
  favicon.svg
```

## Stack

| Layer | Choice |
|---|---|
| Framework | Preact 10 + TypeScript |
| Bundler | Vite 8 |
| Auth | `@atproto/api` (AtpAgent + createSession) |
| DB | `idb` (IndexedDB) |
| Deployment | GitHub Pages via `gh-pages` |
| Package manager | pnpm |

## Phase 1 — Auth + Chat Picker ✅

- Login via Bluesky handle + password (createSession)
- `atproto-proxy: did:web:api.bsky.chat#bsky_chat` routes chat requests through Bluesky Chat service
- Session persisted in localStorage; auto-resume on revisit
- Lists accepted conversations with group name, member count, last message
- Deployed at https://riziles.github.io/bsky-chat-mapper/

### Key Decision: Full password auth over OAuth

OAuth was the original plan, but the Bluesky Chat service requires `com.atproto.access` scope tokens. App passwords (`com.atproto.appPass`) are rejected ("Bad token method"). Full credentials via `createSession` produce the required `access` scope. OAuth may be revisited later.

## Phases (from plan)

| Phase | Status |
|---|---|
| 1 — Auth + chat picker | ✅ Done |
| 2 — Pull + store | ✅ Done |
| 3 — Embed + cluster | ✅ Done |
| 3.5 — Temporal + reply chains | ✅ Done |
| 4 — Mindmap + search | ✅ Done |
| 5 — Polish & QoL | ✅ Done |
| 6 — Deeper analysis | ✅ Done |

See [docs/chat-mapper-plan.md](docs/chat-mapper-plan.md) for the full plan.

## Handoff Notes

- **Auth**: `createSession` with full password (app passwords lack required scope). Proxy header `atproto-proxy: did:web:api.bsky.chat#bsky_chat` for chat routing. Session persisted to localStorage. Custom PDS URLs supported.
- **API**: All chat calls proxied through the user's PDS with the proxy header.
- **Bundle**: ~137KB gzipped + 5MB WASM (cached). Cluster module code-split at 3KB.
- **Deploy**: `pnpm deploy` runs `vite build` then `gh-pages -d dist`. GitHub Pages CDN has ~10min cache.
- **Phase 4 entry point**: `src/app.tsx` — "Generate Map" button → wire to D3 force-directed mindmap using cluster data from `clusterMessages()`.
