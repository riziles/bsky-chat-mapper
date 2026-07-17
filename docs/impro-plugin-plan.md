# Impro Chat Search Plugin — Implementation Plan

## Overview

Build an Impro plugin that pulls group chat messages, stores them in IndexedDB, and provides fast fuzzy search with sender/time filters. Also requires a small upstream PR to Impro to expose the chat API to plugins.

---

## Phase 1: Upstream PR to `improsocial/impro`

**File to change:** `src/js/plugins/pluginService.js` (in Impro's repo)

**Goal:** Expose chat/convo endpoints as host methods so plugins can access them.

Find the `_setupHostMethods()` method (around line 284) and add these new host methods at the end of the block (before the closing `}` of `_setupHostMethods`):

```js
// Add to _setupHostMethods() in pluginService.js

this.pluginBridge.addHostMethod("getConvoList", async (plugin) => {
  if (!this.session) return null;
  await this._dataLayer.declarative.ensureCurrentUser();
  await this._dataLayer.requests.loadConvoList({ reload: true, limit: 30 });
  return this._dataLayer.derived.$convoList.get() ?? [];
});

this.pluginBridge.addHostMethod("getConvoMessages", async (plugin, { convoId, cursor }) => {
  if (!this.session) return null;
  await this._dataLayer.requests.getMessages({
    convoId,
    cursor,
    limit: 100,
  });
  const msgs = this._dataLayer.derived.$messages.get(convoId);
  const cursorVal = this._dataLayer.derived.$messagesCursors.get(convoId);
  return {
    messages: msgs ?? [],
    cursor: cursorVal ?? null,
  };
});

this.pluginBridge.addHostMethod("getCurrentUser", () => {
  if (!this.session) return null;
  return {
    did: this.session.did,
    handle: this.session.handle,
  };
});
```

**Note:** Check if `getCurrentUser` already exists (it might from earlier versions). If so, skip it. The key new ones are `getConvoList` and `getConvoMessages`.

**Also check:** Impro's dataLayer method names. They might differ slightly — search for `loadConvoList` and `getMessages` or `loadMessages` in `src/js/dataLayer/requests.js` to confirm the exact method signatures. Adjust parameter names accordingly.

**Optional:** If the above approach (reading from derived stores) doesn't return fresh data reliably, an alternative is to call Impro's internal API client directly. Look at how Impro's own `chatDetail.view.js` fetches messages and replicate that pattern in the host method.

**PR description:** 
> Add `getConvoList` and `getConvoMessages` host methods to the plugin bridge. These expose the existing chat data layer to plugins, enabling chat-search, chat-analytics, and other conversation-oriented plugins. No breaking changes, no new dependencies.

---

## Phase 2: Plugin Structure

```
impro-plugin-chat-search/
├── manifest.json
├── src/
│   └── main.js          # Plugin entry point
│   └── db.js            # IndexedDB wrapper
│   └── search.js        # MiniSearch setup + fuzzy search
│   └── page.js          # Full-page view (lit-html)
│   └── sidebar.js       # Sidebar icon registration
├── styles.css            # Plugin styles
├── package.json
└── README.md
```

### `manifest.json`

```json
{
  "id": "chat-search",
  "name": "Chat Search",
  "version": "0.1.0",
  "author": "Your Name",
  "description": "Pull and fuzzy-search group chat messages",
  "permissions": {}
}
```

No fetch permissions needed — all data comes through host methods.

---

## Phase 3: Plugin Implementation Details

### 3a. `db.js` — IndexedDB Storage

Ported from bsky-chat-mapper `src/db.ts`.

- Database name: `"impro-chat-search"`
- Single object store: `"messages"`, keyPath: `"id"` (composite `"{convoId}:{messageId}"`)
- Index on `sentAt` for time-range filtering
- Schema per message:
  ```
  id: string          // "{convoId}:{messageId}"
  convoId: string
  text: string
  senderDid: string
  senderHandle?: string
  sentAt: string      // ISO timestamp
  ```

- Functions:
  - `openDB()` — opens/creates IndexedDB
  - `storeMessages(convoId, messages)` — bulk insert (use `put()`, not `add()`, so re-fetches overwrite)
  - `getMessages(convoId)` — return all for a convo
  - `getAllMessages()` — return all across all convos
  - `getLatestTimestamp(convoId)` — for incremental pulls
  - `clearConvo(convoId)` — delete all messages for a convo

**Important:** IndexedDB in sandboxed workers — Impro plugins run in either a sandboxed iframe or a Worker. Both have `indexedDB` access. Test in the actual Impro dev environment early to confirm.

### 3b. `search.js` — Fuzzy Search

Ported from bsky-chat-mapper `src/search.tsx`.

- Use **MiniSearch** (6KB, no WASM, `npm install minisearch`)
- Index fields: `text`, `senderHandle`, `senderDid`
- Options: `{ fields: ['text', 'senderHandle'], storeFields: ['id', 'convoId', 'text', 'senderDid', 'senderHandle', 'sentAt'] }`
- Functions:
  - `createIndex(messages)` — create MiniSearch instance from message array
  - `search(query, options)` — fuzzy search with `{ fuzzy: 0.3, prefix: true }`
  - `filterBySender(results, senderDid)` — post-filter by sender
  - `filterByTime(results, start, end)` — post-filter by time range

### 3c. `page.js` — Full-Page View

Register via Impro's plugin API (see sample plugin for full-page pattern — likely a `slot` registration with a page route).

Layout:
```
┌──────────────────────────────────────────────┐
│  ← Back to Chats                             │
│                                              │
│  [Select convo ▼]  [Pull messages]           │
│  Progress: ████████░░ 80%                    │
│                                              │
│  🔍 [Search messages...]      [Sender ▼]     │
│  Time: [7d] [30d] [90d] [All]               │
│                                              │
│  Results (42):                               │
│  ┌──────────────────────────────────────────┐│
│  │ alice.bsky.social · 2h ago               ││
│  │ I think we should use the new API for... ││
│  ├──────────────────────────────────────────┤│
│  │ bob.bsky.social · 5h ago                 ││
│  │ has anyone seen the latest design...     ││
│  └──────────────────────────────────────────┘│
└──────────────────────────────────────────────┘
```

- Convo selector: dropdown populated from `getConvoList()` host call
- "Pull messages" button: calls `getConvoMessages()` in a loop (pagination via cursor), stores in IndexedDB, shows progress
- Search bar: MiniSearch fuzzy search, debounced 300ms
- Sender filter: extracted from search results, dropdown
- Time filters: quick-select buttons
- Results: scrollable list, clicking a result could link to Impro's chat detail view at the right message position

**Note on lit-html:** Impro uses lit-html for rendering. The plugin's full-page view should use the same pattern as Impro's existing views (see `chat.view.js` for reference). Import lit-html from Impro's bundled path: `import { html, render } from "/js/lib/lit-html.js"` (verify exact path).

### 3d. `sidebar.js` — Sidebar Entry Point

Register a sidebar item so users can open the search page:

```js
this.addSidebarItem("search-line", "Chat Search", () => {
  // Navigate to plugin page
  app.navigate("/plugin/chat-search");
});
```

### 3e. `main.js` — Plugin Entry Point

```js
import { Plugin } from "@impro.social/impro-plugin";
import { openDB, storeMessages, getAllMessages } from "./db";
import { createIndex, search } from "./search";

export default class ChatSearchPlugin extends Plugin {
  async onload() {
    this.db = await openDB();
    
    // Register sidebar item for navigation
    this.addSidebarItem("search-line", "Chat Search", () => {
      this.app.navigate("/plugin/chat-search");
    });

    // Register full-page view (pattern depends on Impro's slot/page API)
    // Check sample plugin or slot registration docs
  }

  // Host call wrappers
  async fetchConvoList() {
    return await this.callHost("getConvoList");
  }

  async fetchConvoMessages(convoId, cursor = null) {
    return await this.callHost("getConvoMessages", { convoId, cursor });
  }

  async pullAllMessages(convoId, onProgress) {
    let cursor = null;
    let total = 0;
    do {
      const result = await this.fetchConvoMessages(convoId, cursor);
      if (!result?.messages?.length) break;
      await storeMessages(this.db, convoId, result.messages);
      total += result.messages.length;
      cursor = result.cursor;
      onProgress?.(total, cursor);
    } while (cursor);
    return total;
  }
}
```

---

## Phase 4: Build, Test, Publish

1. **Build:** Bundle with a bundler that outputs a single `main.js` (esbuild or rollup). Impro loads `main.js` from tagged releases.
2. **Test locally:** Symlink into Impro's `plugins-local/` directory per [Impro's dev guide](https://github.com/improsocial/impro/blob/main/plugins.md#local-development)
3. **Release:** Tag a commit with version number (e.g. `0.1.0`), push to a public GitHub repo
4. **List in community plugins:** PR to `improsocial/impro-releases`

---

## Risks & Unknowns

| Risk | Mitigation |
|------|-----------|
| `getConvoMessages` host method may not return fresh data from derived stores | Check Impro's dataLayer — may need to call `_dataLayer.requests.getConvoMessages({ convoId, cursor, limit: 100 })` directly and return its raw response instead of reading from `$messages` store |
| IndexedDB may not be available in sandboxed iframe | Test early. If blocked, switch to `loadData`/`saveData` (but those are small — meant for settings, not bulk message storage). Alternatively request `csp-allow-indexeddb` on the sandbox iframe in the Impro PR |
| lit-html import path may differ | Check Impro's `src/js/lib/` directory. May be `/js/lib/lit-html.js` or similar |
| Full-page registration API may differ from Obsidian's pattern | Check Impro's slot/page registration docs or read the `addRegistrationTarget("slot", ...)` handler in `pluginService.js` to see how pages are registered |
| MiniSearch bundle size | MiniSearch is ~6KB gzipped. Fine for a plugin |
| `@impro.social/impro-plugin` package may not export `Plugin` with `callHost` | Check the actual exports — the sample plugin uses `this.loadData()`/`this.saveData()` but host calls may use a different API like `this.app.callHost()` or the bridge directly |

---

## Approximate Effort

| Step | Effort |
|------|--------|
| Impro PR (upstream) | ~1 hour |
| Plugin scaffolding (manifest, build, dev loop) | ~2 hours |
| IndexedDB module | ~1 hour (port from existing) |
| MiniSearch integration | ~1 hour (port from existing) |
| Full-page UI (convo picker, pull button, search, results) | ~3 hours |
| Sidebar registration + navigation | ~30 min |
| Testing + polish | ~2 hours |
| **Total** | **~10 hours** |
