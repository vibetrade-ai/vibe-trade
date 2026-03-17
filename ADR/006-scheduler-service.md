# ADR-006: Scheduler Service — Repeating LLM Runs and Market-Closed Handling

## Status
Superseded by [ADR-011](./011-unify-triggers-and-schedules.md)

## Context

ADR-005 sketched a future scheduler that would work by registering trigger records on a cron and letting the heartbeat evaluate them. The actual requirement turned out to be different: the user wants **repeating autonomous analysis sessions** — e.g. "every market day at 9:15am, read the news, find intraday setups, queue promising trades for my review." This is categorically different from a one-shot condition check. A trigger fires once and is consumed; a schedule fires repeatedly forever.

Two separate needs drove this ADR:

1. **Time-based repeating runs** — a cron expression defines when an autonomous Claude Sonnet loop fires. Each run is an independent analysis session: it can queue multiple trade approvals, register condition-based triggers, or call `no_action`. After completing, the schedule advances to its next firing time and waits again.

2. **Time-based one-shot triggers** — sometimes a reasoning job wants to follow up at a specific moment ("re-check this setup at 11am"). This is a one-shot time trigger, not a repeating schedule. It fits naturally into the existing trigger system with a new `mode: "time"` condition variant.

A third issue surfaced at the same time: the heartbeat was evaluating code and LLM triggers every 60 seconds on weekends and holidays, making Dhan API calls and wasting Haiku tokens against stale market data.

---

## Decisions

### 1. Schedules and triggers are separate concepts

ADR-005's sketch had the scheduler create trigger records. Rejected because:

- Triggers are one-shot and consumed on fire. Modelling a repeating schedule as a trigger requires re-registering a new trigger after each fire — fragile and hard to audit.
- A trigger's `condition` is a market condition check. A schedule's firing condition is purely temporal (cron expression) — conceptually different.
- Schedules need their own run history (outcome per invocation), pause/resume lifecycle, and CRUD surface.

**Decision:** Schedules live in their own `scheduler/` module with their own store, service, and runner. The heartbeat is unchanged.

```typescript
// Trigger — condition-based OR time-based, fires once, consumed
type TriggerCondition =
  | { mode: "code"; expression: string }
  | { mode: "llm";  description: string }
  | { mode: "time"; fireAt: string };      // ISO — fires once when Date.now() >= fireAt

// Schedule — time-based, repeating, persists
interface Schedule {
  id: string;
  name: string;
  description: string;
  cronExpression: string;      // 5-field, evaluated in IST via cron-parser
  tradingDaysOnly: boolean;    // skip NSE holidays and weekends
  prompt: string;              // verbatim instruction given to the LLM at each run
  status: "active" | "paused" | "deleted";
  lastRunAt?: string;
  nextRunAt: string;           // precomputed ISO, recomputed after each run
  createdAt: string;
  staleAfterMs?: number;       // max ms overdue before job is skipped; set by Claude at creation time
}
```

### 2. cron-parser@4 with IST timezone

`cron-parser@^4.9.0` (not v5 — breaking API changes in v5) provides `parseExpression(expr, { tz: "Asia/Kolkata" })`. Two helpers in `service.ts`:

```typescript
function computeNextRunAt(cron: string, after = new Date()): string {
  return parseExpression(cron, { tz: "Asia/Kolkata", currentDate: after })
    .next().toISOString();
}

function computeNextTradingRunAt(cron: string, after = new Date()): string {
  const interval = parseExpression(cron, { tz: "Asia/Kolkata", currentDate: after });
  while (true) {
    const candidate = interval.next().toDate();
    const dateStr = candidate.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (isTradingDay(dateStr).is_trading_day) return candidate.toISOString();
  }
}
```

`tradingDaysOnly: true` skips NSE holidays and weekends at `nextRunAt` computation time — no separate "is today a trading day?" check is needed at fire time beyond computing the right next slot.

**Rationale:** Computing `nextRunAt` in advance and storing it on disk means the service only needs `schedule.nextRunAt <= now` to decide whether to fire. This is simple, crash-safe (see §5), and makes the UI display of "next run" trivial.

### 3. runScheduleJob vs runReasoningJob — key differences

`runner.ts:runScheduleJob` is adapted from `heartbeat/runner.ts:runReasoningJob`. The structural differences:

| | `runReasoningJob` | `runScheduleJob` |
|---|---|---|
| Initial message | Trigger condition JSON + snapshot | `schedule.prompt` verbatim |
| After `queue_trade_approval` | Sets `terminated = true` | Does **not** terminate — loops to queue more |
| After `queue_hard_trigger_approval` | Sets `terminated = true` | Does not terminate |
| Audit destination | `TriggerAuditStore` (JSONL) | `ScheduleRunStore` (JSONL) |
| Outcome type | Single approval or no_action | `{ type: "completed"; approvalIds[] }` \| `{ type: "no_action" }` \| `{ type: "error" }` |

The key difference is multi-approval semantics. A premarket scan might legitimately identify 3–4 setups and queue all of them before calling `no_action`. Terminating after the first `queue_trade_approval` would force multiple LLM jobs for a single scan.

### 4. Business logic isolated in runner.ts — swappable scheduling mechanism

`SchedulerService` (using `setInterval`) contains only scheduling mechanics: tick every 60s, find due schedules (`nextRunAt <= now`), respect concurrency cap. All business logic lives in `fireSchedule() → runScheduleJob()`.

To migrate to BullMQ: implement `BullMQSchedulerService` that uses BullMQ repeatable jobs and calls `fireSchedule()`. No other files change.

**Rationale:** The `setInterval` approach fires "at most once per missed window" on restart. If "exactly N fires for N missed windows" semantics are ever needed (e.g. replay 3 days of missed scans), BullMQ handles this natively via Redis-backed repeatable job tracking.

### 5. Stale job skipping + double-fire prevention

**Stale skip:** Before launching a due schedule, the tick checks whether the job is overdue beyond its `staleAfterMs` threshold (default: 5 minutes, hard cap: 2 hours). If it is, the job is skipped — `nextRunAt` is advanced normally and the skip is logged. The run is not recorded in `ScheduleRunStore`.

```typescript
const staleAfterMs = Math.min(s.staleAfterMs ?? DEFAULT_STALE_MS, MAX_STALE_MS);
const overdueMs = now.getTime() - new Date(s.nextRunAt).getTime();
if (overdueMs > staleAfterMs) {
  void scheduleStore.updateNextRunAt(s.id, nextRunAt);
  console.log(`[scheduler] skipping stale job "${s.name}" (overdue by ${Math.round(overdueMs / 60000)}m)`);
  return false; // filtered out
}
```

**Why stale skipping matters for trading:** A "premarket scan at 9:15am" run at 2pm would call real-time APIs and produce trade proposals anchored to the wrong market context. Skipping is always correct; running late is almost always wrong.

**Claude sets `staleAfterMs` at creation time** based on the cron cadence and task urgency — e.g. ~90 seconds for a per-minute scan, ~10 minutes for a daily open task. This is part of the `register_schedule` tool's input schema. The server caps it at 2 hours regardless.

**Double-fire prevention:** `updateLastRun` is called *before* launching the async job:

```typescript
// Advance nextRunAt BEFORE launching async job
await this.scheduleStore.updateLastRun(schedule.id, nowIso, nextRunAt);

// Then fire asynchronously
runScheduleJob(...).catch(...).finally(() => { this.activeJobs--; });
```

If the server crashes after `updateLastRun` but before `runScheduleJob` completes, that run is absent from history — but the schedule does not double-fire on restart. Combined with stale skipping, a missed window on restart is simply dropped rather than replayed with misleading data.

### 6. Resume recomputes nextRunAt from now

When a paused schedule is resumed, `nextRunAt` is recomputed from the current moment — not from the original paused timestamp. This prevents an immediate fire after a long pause.

```typescript
// POST /api/schedules/:id/resume
const nextRunAt = schedule.tradingDaysOnly
  ? computeNextTradingRunAt(schedule.cronExpression, now)
  : computeNextRunAt(schedule.cronExpression, now);
await store.setStatus(id, "active");
await store.updateNextRunAt(id, nextRunAt);
```

### 7. Time-mode triggers in the heartbeat

```typescript
type TriggerCondition =
  | { mode: "code"; expression: string }
  | { mode: "llm";  description: string }
  | { mode: "time"; fireAt: string };   // new
```

`evaluateTimeTriggers()` in `evaluator.ts` is a pure time comparison — no snapshot needed:

```typescript
export function evaluateTimeTriggers(triggers: Trigger[]): string[] {
  const now = Date.now();
  return triggers
    .filter(t => now >= new Date((t.condition as { fireAt: string }).fireAt).getTime())
    .map(t => t.id);
}
```

Time triggers evaluated first in `tick()`, before the market-active check (§8) — they fire regardless of whether the market is open.

Use case: a reasoning job running at 10am identifies a setup and registers a time trigger to re-check at 2pm. The `{ mode: "time" }` variant lets it do this without also registering a `{ mode: "code" }` trigger with a timestamp expression.

### 8. Heartbeat skips code/LLM evaluation when market is closed

```typescript
const isMarketActive = marketStatus.session === "pre_market"
  || marketStatus.session === "open"
  || marketStatus.session === "post_market";

if (codeTriggers.length > 0 || llmTriggers.length > 0) {
  if (!isMarketActive) {
    console.log(`[heartbeat] market ${session} — skipping until ${next_open}`);
  } else {
    snapshot = await buildSnapshot(...);
    // evaluate
  }
}
```

`buildSnapshot` also conditionally skips quote fetches when the market is closed — it still fetches positions and funds (account data, always valid) but skips equity and index quote API calls that would return stale zero-data:

```typescript
isMarketActive && equitySymbols.length > 0 ? fetchEquityQuotes() : Promise.resolve(null),
isMarketActive ? dhan.getQuote(["13", "25"], "IDX_I") : Promise.resolve(null),
```

**Rationale:** Code triggers referencing `quotes["X"].lastPrice` against a closed-market snapshot would compare against 0 or the previous day's close — meaningless or misleading. LLM triggers waste Haiku tokens evaluating stale data. The market-closed skip costs nothing and eliminates both problems. Time triggers are explicitly exempt — they're not market-data-dependent.

### 9. Safe quote proxy in code trigger evaluator

```typescript
const safeQuotes = new Proxy(snapshot.quotes, {
  get(target, prop: string) {
    return target[prop] ?? SAFE_QUOTE;  // zero-value object for missing symbols
  },
});
```

When a quote fetch partially fails (Dhan returns a subset of requested symbols), expressions like `quotes["RELIANCE"].lastPrice` would throw `TypeError: Cannot read properties of undefined`. The Proxy returns a safe zero-value object instead, making the condition evaluate to `false` without aborting the tick.

The catch block in `evaluateCodeTriggers` is retained for genuinely malformed expressions, downgraded from `console.error` to `console.warn` since this is a non-fatal, per-trigger failure.

---

## Architecture diagram

```
User (chat)
    │  register_schedule(name, cron, prompt, tradingDaysOnly)
    │  pause_schedule / resume_schedule / delete_schedule
    ▼
ScheduleStore (schedules.json, soft-delete)
    ▲                          │  nextRunAt <= now
    │                          ▼
SchedulerService (60s tick)
    │
    ├─ tradingDaysOnly + non-trading day → updateNextRunAt only, skip
    │
    ├─ overdueMs > staleAfterMs          → updateNextRunAt only, skip (stale guard)
    │
    ├─ updateLastRun(now, nextRunAt)     ← write before launching (double-fire guard)
    │
    └─ runScheduleJob(schedule, ...)     ← Sonnet, max 10 turns
           │
           ├─ queue_trade_approval × N  → ApprovalStore (multiple allowed)
           ├─ queue_hard_trigger_approval → ApprovalStore
           ├─ register_soft_trigger     → TriggerStore
           └─ no_action / end_turn      → ScheduleRunStore (outcome logged)

HeartbeatService (60s tick, unchanged except):
    │
    ├─ market closed?
    │    yes → skip snapshot + code/llm eval, log next_open
    │    no  → buildSnapshot (quotes only if market active) → evaluate
    │
    ├─ evaluateTimeTriggers()  ← always runs, pure time comparison, no snapshot
    ├─ evaluateCodeTriggers()  ← safeQuotes Proxy, vm.runInNewContext
    └─ evaluateLlmTriggers()   ← single Haiku call

Frontend
    GET /api/schedules        → SchedulesPanel (Active sub-tab, 30s poll)
    GET /api/schedules/runs   → SchedulesPanel (Run History sub-tab, 30s poll)
    POST /api/schedules/:id/pause
    POST /api/schedules/:id/resume
    DELETE /api/schedules/:id
```

---

## File layout

```
backend/src/lib/scheduler/
  types.ts     — Schedule, ScheduleRun, ScheduleRunOutcome
  store.ts     — LocalScheduleStore (schedules.json) + LocalScheduleRunStore (schedule-runs.jsonl)
  service.ts   — SchedulerService (setInterval tick) + computeNextRunAt helpers
  runner.ts    — runScheduleJob() — autonomous Sonnet loop

backend/src/routes/
  schedules.ts — GET /api/schedules, GET /api/schedules/runs, POST pause/resume, DELETE

frontend/src/components/
  SchedulesPanel.tsx — Active (cards + pause/resume) + Run History (outcome badges)
```

Modified files: `heartbeat/types.ts`, `heartbeat/evaluator.ts`, `heartbeat/service.ts`, `heartbeat/snapshot.ts`, `storage/types.ts`, `storage/local/index.ts`, `storage/index.ts`, `lib/tools.ts`, `routes/chat.ts`, `server.ts`.

---

## Consequences

- **Cost profile**: schedules run only when due; a `tradingDaysOnly` 9:15am schedule costs one Sonnet session on each trading day morning. Heartbeat cost on closed days drops to zero Dhan API calls and zero Haiku calls — only the `list()` store read and time-trigger evaluation remain.
- **Reliability**: `updateLastRun` before job launch means no double-fire on restart. Missed windows are skipped (stale guard) rather than replayed with stale market context.
- **Correctness**: code triggers no longer throw or misfire during closed market or partial quote failure.
- **Scaling**: `schedules.json` is appropriate for single-user localhost. BullMQ with Redis is the natural upgrade for hosted multi-user deployment — the `runner.ts` boundary makes this a one-file swap.

> **Amendment — ADR-010:** `runner.ts` was significantly revised after a 44-minute timeout incident. See [ADR-010](./010-scheduler-runner-performance.md) for details on the candle cache, history compaction, parallel tool dispatch, wall-clock timeout, and `max_tokens` reduction.
