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

### Key Decision: App password auth over OAuth

OAuth was the original plan, but the Bluesky Chat service requires `com.atproto.access` scope tokens. App passwords (`com.atproto.appPass`) are rejected ("Bad token method"). Full credentials via `createSession` work because they produce `access` scope tokens. OAuth may be revisited later.

## Phases (from plan)

| Phase | Status |
|---|---|
| 1 — Auth + chat picker | ✅ Done |
| 2 — Pull + store | ⬜ Next |
| 3 — Embed + cluster | ⬜ |
| 4 — Mindmap + search | ⬜ |

See [docs/chat-mapper-plan.md](https://github.com/riziles/bluesky-tricks/blob/main/docs/chat-mapper-plan.md) for the full plan.

## Handoff Notes

- **Auth**: Uses `AtpAgent` with full credentials. Proxy header added via `configureProxy("did:web:api.bsky.chat#bsky_chat")`. Session stored in localStorage under `bsky-chat-mapper-session`.
- **Chat API**: All calls go through `scalycap.us-west.host.bsky.network` (Bluesky's PDS infrastructure) with the proxy header. Direct calls to `api.bsky.app` or `bsky.social` don't work for chat.
- **Why not OAuth**: OAuth tokens were rejected (401/403) by this PDS for chat proxying. The DPoP-based tokens may work on other PDS instances but not reliably.
- **Bundle**: ~132KB gzipped (includes all atproto deps).
- **Deploy**: `pnpm deploy` runs `vite build` then `gh-pages -d dist`. GitHub Pages CDN has ~10min cache.
- **Playwright testing**: Saved bsky.app session at `.playwright-cli/bsky-auth.json` (gitignored). Can be used for future testing.
- **Phase 2 entry point**: `src/app.tsx` line with `onClick={() => alert("Phase 2 coming soon!")}` — wire to message fetching + time filter UI.
