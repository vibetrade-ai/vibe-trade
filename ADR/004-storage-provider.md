# ADR-004: Storage Provider Pattern

## Status
Accepted

## Context

Chat history is currently ephemeral — lost on page refresh or backend restart. Beyond chat, VibeTrade will soon add strategies (AI-generated trading plans) and portfolio tracking (trades, P&L). Each of these needs persistence.

All three stores have the same deployment split:
- **Localhost**: flat files (JSONL, Markdown, JSON) — zero infrastructure, works offline, easy to inspect
- **Hosted**: Postgres (structured/queryable data) and S3/R2 (document blobs)

Rather than scatter file I/O across routes or hard-code a storage backend, we introduce a `StorageProvider` abstraction that:
1. Hides which backend is in use from all routes and business logic
2. Allows the hosted implementation to use different backends per store type (e.g. Postgres for conversations, S3 for strategy docs) as a private implementation detail
3. Makes adding new stores (strategies, portfolio) a localised change: add an interface + a local implementation + wire into the provider

---

## Decisions

### StorageProvider interface with named sub-stores

```typescript
export interface StorageProvider {
  conversations: ConversationStore;
  // strategies: StrategyStore;   — future phase
  // portfolio: PortfolioStore;   — future phase
}
```

Each store is a plain interface. Routes depend only on the interface, never on file paths or DB connections.

**Rationale:** Dependency inversion keeps routes testable (inject a mock store) and swappable (local → hosted without touching routes).

### Local implementation uses JSONL files

One `Anthropic.MessageParam` JSON object per line in `backend/data/<conversationId>.jsonl`.

- Append-only writes — no rewriting the file on every turn
- Load: read all lines, parse each, return array; missing file → empty array
- `backend/data/` is gitignored and created at startup

**Rationale:** JSONL is the simplest possible durable store — readable by any text editor, easily imported into other tools, and no schema migrations. Append-only means O(1) writes regardless of conversation length.

### `createStorageProvider()` factory reads the environment

```typescript
export function createStorageProvider(): StorageProvider {
  // Later: if (process.env.DATABASE_URL) return new DatabaseStorageProvider(...)
  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  return new LocalStorageProvider(dataDir);
}
```

The selection logic lives in one place. Adding a hosted provider is a two-line change here plus a new class elsewhere.

**Rationale:** Single point of configuration. Routes never need to know which provider was selected.

### `conversationId` flows from frontend → WS query string → backend

- Frontend generates a UUID on first load, persisted in `localStorage` (pointer only, no message data)
- Passed as `?conversationId=<uuid>` on the WebSocket URL
- Backend uses it as the JSONL filename key
- On conversation load or switch, the frontend fetches `GET /api/conversations/:id/messages` and renders the result; there is no client-side item cache

**Rationale:** The backend JSONL is the single source of truth. A client-side display cache was prototyped but dropped — it introduced inconsistencies when switching conversations across sessions and added complexity without meaningful performance benefit (the fetch is fast and only happens once per switch).

### `GET /api/conversations/:id/messages` returns a flat view list

The endpoint converts `MessageParam[]` into a frontend-friendly `{ role, text, toolName? }[]`:

- User text messages → `role: "user"`
- Assistant text blocks → `role: "assistant"` (tool_use blocks within the same turn become separate `role: "tool"` entries)
- Tool-result turns (user role, all `tool_result` blocks) → skipped; they are implementation detail

**Rationale:** `MessageParam` is Claude's internal format and includes tool_use/tool_result interleaving that is opaque to the UI. A dedicated view projection keeps the frontend decoupled from Anthropic API internals and lets us evolve the display independently.

### Stale pending approvals are denied on reconnect

Any approval request that was `"pending"` when the WebSocket closes is resolved as `"denied"` by the backend (the pending promise is rejected in the `close` handler). On the frontend, in-progress approval cards disappear naturally when the conversation is re-fetched from the backend after a reload, since the JSONL only contains completed message pairs.

**Rationale:** A pending approval cannot be actioned after a connection drop. Denying automatically is safe — the user can re-send the message if needed.

---

## File layout

```
backend/src/lib/storage/
  types.ts                       — ConversationStore + StorageProvider interfaces
  local/
    conversation-store.ts        — JSONL implementation (load, append, list)
    index.ts                     — LocalStorageProvider
  index.ts                       — createStorageProvider() factory

backend/src/routes/
  conversations.ts               — GET /api/conversations (list) + GET /api/conversations/:id/messages (view)

backend/data/                    — runtime data dir (gitignored)
```

---

## Consequences

- **Adding a hosted provider** requires: a new class implementing `StorageProvider`, wired into the factory. No route changes.
- **Adding a new store** (strategies, portfolio) requires: an interface in `types.ts`, a local implementation, a field on `LocalStorageProvider`, and wiring in `server.ts`. Routes remain unaffected.
- **Testing** routes is straightforward: pass a mock `ConversationStore` via the `opts` argument to `chatRoute`.
- **Data inspection** for localhost deployments is as simple as `cat backend/data/<id>.jsonl | jq .`.
