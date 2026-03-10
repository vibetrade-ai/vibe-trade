# ADR-010: Scheduler Runner — Latency, Cost, and Timeout Fixes

## Status
Accepted

## Context

A premarket scan (NIFTY500 `get_top_movers` + `compute_indicators` across ~10 symbols) ran for 44 minutes before hitting the Anthropic SDK's 600s default per-call timeout, costing ~$5–6. Root causes identified:

1. **`get_top_movers(NIFTY500)` = 20 serial Dhan API batch fetches** — 500 stocks / 25 per batch = 20 sequential HTTP calls, ~80s per tool invocation.
2. **`compute_indicators` re-fetches candle data independently** — the same Dhan endpoint was called twice for identical symbol/interval/days when `get_historical_data` and `compute_indicators` were used together, the common case.
3. **Full tool results stored verbatim in history** — `get_historical_data` returns 200 candles (~30 KB); `compute_indicators` returns 50 bars with indicators (~25 KB). Across 10 turns, 500+ KB was re-sent to the LLM on every call.
4. **No wall-clock timeout** — a job could run all 10 turns with no time cap.
5. **No Anthropic SDK per-call timeout** — defaulted to 600s; one slow call hung for 10 minutes.
6. **Tool calls within a turn ran sequentially** — when Claude batched 3 reads in one turn they executed one-by-one.
7. **`max_tokens: 4096`** — generous for a task that generates tool call JSON, not prose.

---

## Decisions

### 1. Extract `fetchCandles()` to `dhan/candles.ts`

**New file:** `backend/src/lib/dhan/candles.ts`

Exports `parseDhanCandles`, `dateRange`, `resolveInstrument`, and `fetchCandles()` — the full pipeline from symbol string to `Candle[]`. Previously these were private helpers duplicated inside the `get_historical_data` and `compute_indicators` handlers in `tools.ts`.

`tools.ts` now imports `fetchCandles` and `resolveInstrument` from `./dhan/candles.js`. The handler bodies collapse to two lines each.

**Why a separate file:** `resolveInstrument` and `fetchCandles` are now used by both `tools.ts` (for interactive chat) and `runner.ts` (for the scheduler's candle cache). Placing shared data-fetching logic in `dhan/candles.ts` avoids a circular dependency (runner → tools → runner).

### 2. Two-cache design

Two caches with different scopes are used in `runner.ts`:

**`resultCache` — per-run `Map<string, string>`**
- Key: `"toolName:JSON.stringify(args)"`
- Scoped to one `runScheduleJob()` call; reset each run
- Stores the result that was already returned to the LLM for a given tool call
- **Cache miss:** run handler, store result, return `summariseForHistory(result)` to history
- **Cache hit:** return stored result directly (Claude re-called to get full data — "lazy load")

**`candleCache` — module-level `TtlCache<Candle[]>`**
- Key: `"symbol:interval:days"`
- Persists across runs within the same process lifetime; TTL keeps data fresh
- TTL formula: `interval === "D" ? 4h : interval_minutes * 1min`
- Used exclusively by the `get_historical_data` and `compute_indicators` special cases

**Why two caches:** `resultCache` handles idempotent tool re-execution within a run. `candleCache` handles cross-tool data sharing between `get_historical_data` and `compute_indicators`, which use identical Dhan requests. Merging them would require `compute_indicators` to look up `get_historical_data`'s cache key — cross-tool coupling by design, which is wrong.

**`TtlCache<T>` — no new dependencies:**
```typescript
class TtlCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();
  get(key: string): T | undefined { ... }
  set(key: string, value: T, ttlMs: number): void { ... }
}
```

### 3. Compact history entries (`summariseForHistory`)

All generic tool results are compacted before entering conversation history on a cache miss:

```typescript
const HISTORY_RESULT_LIMIT = 3000; // chars

function summariseForHistory(toolName, text): string {
  if (text.length <= HISTORY_RESULT_LIMIT) return text;
  // array: keep first 5 items + omission notice with "call again" hint
  // string: slice to 3000 chars + omission notice
}
```

`get_historical_data` and `compute_indicators` bypass this — they produce their own purpose-built compact summaries (period high/low/avg-vol + last 10 candles; last 5 candles with indicators), reducing ~30 KB and ~25 KB respectively to ~2–3 KB.

The "call again with same args for full result" hint in the omission notice is intentional: a resultCache hit on a re-call returns the full stored result, giving Claude the data it needs without an additional API call.

### 4. Parallel batch fetches in `get_top_movers`

The sequential `for` loop over Dhan API batches is replaced with chunked `Promise.all`, max 5 concurrent batches:

```
Before: 20 serial × 4s = ~80s for NIFTY500
After:  4 chunks × 5 parallel × 4s = ~16s
```

No new npm dependencies. The 5-batch concurrency limit avoids overwhelming the Dhan rate limiter.

### 5. Parallel tool execution within a turn

`Promise.all(toolUses.map(...))` replaces the sequential `for...of` loop in the runner. Tools within a turn are independent reads/writes with no shared mutable state (the `resultCache` is keyed by args, so concurrent writes for different args are safe). `terminated` and approval IDs are collected after all promises resolve.

### 6. Wall-clock timeout on the job

The multi-turn loop is extracted into `runJobLoop()` and raced against a 5-minute timer:

```typescript
await Promise.race([
  runJobLoop(),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Job exceeded 5-minute wall-clock limit")), JOB_TIMEOUT_MS)
  ),
]);
```

The existing `catch` block records the error to `ScheduleRunStore` with `type: "error"`.

**Why 5 minutes:** With all fixes applied, typical scans finish in 1–2 minutes. A 5-minute wall clock correctly terminates genuinely runaway jobs (stuck LLM call + retry loop) without false-positives on legitimate multi-turn scans.

### 7. Anthropic SDK per-call timeout

`{ timeout: 120_000 }` is passed as the second argument to `anthropic.messages.create()`. Sonnet typically responds in 5–30s; 120s gives 4× margin while being far from the 600s default. This stops a single hanging LLM call from consuming the entire wall-clock budget.

### 8. Reduce `max_tokens` to 2048

The runner's Claude calls produce tool call JSON and brief reasoning strings, not prose or long explanations. 2048 tokens is sufficient for 4+ batched tool calls per turn. Cutting from 4096 halves the maximum output token budget per turn, directly reducing both latency and cost for turns where Claude outputs near the limit.

---

## What was NOT changed

- `get_top_movers` is not removed or restricted — parallelization is the correct fix, not removing the tool.
- Schedule `staleAfterMs` logic is unchanged — that's skip-if-stale, not job duration.
- Tool schemas exposed to Claude are unchanged — all caching is runner-internal.
- `tools.ts` handlers for `get_historical_data` and `compute_indicators` retain their full-result return for interactive chat. The compact summary path lives only in `runner.ts`.

---

## File layout changes

```
backend/src/lib/dhan/
  candles.ts    ← NEW: parseDhanCandles, dateRange, resolveInstrument, fetchCandles

Modified:
  lib/tools.ts           — uses fetchCandles + resolveInstrument from candles.ts;
                           parallel batches in get_top_movers
  scheduler/runner.ts    — TtlCache, module-level candleCache, per-run resultCache,
                           summariseForHistory, parallel tool dispatch, wall-clock
                           timeout, per-call timeout, max_tokens 2048
```

---

## Consequences

- **Latency:** A NIFTY500 premarket scan that previously ran 44+ minutes is expected to complete in 1–3 minutes.
- **Cost:** Reduced by: fewer Dhan API calls (candle sharing), smaller LLM context (history compaction), fewer LLM output tokens (max_tokens 2048), shorter wall-clock time.
- **Reliability:** Jobs now have two hard time bounds — 2-minute per LLM call, 5-minute total — and record `type: "error"` in run history rather than hanging indefinitely.
- **Cross-run candle reuse:** A daily candle dataset fetched by a 9:15am scan is cached for 4 hours, so a 10:00am follow-up scan reuses it at zero Dhan cost.
- **Interactive chat unaffected:** `tools.ts` handlers are unchanged; the compact summary and caching logic is runner-only.
