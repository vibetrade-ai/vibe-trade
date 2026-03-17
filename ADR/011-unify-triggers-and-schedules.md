# ADR-011: Unify Triggers and Schedules

## Status
Accepted

## Context

ADR-006 introduced a `SchedulerService` as a concept separate from the `HeartbeatService` introduced in ADR-005. The rationale at the time was that "triggers are one-shot and consumed on fire" while schedules "fire repeatedly forever" — so they were modelled as different entities with different stores, different Claude tools, different API routes, and different UI panels.

This separation turned out to be premature. In practice:

- Both pipelines share the same 60-second polling loop
- Both share the same 3-job concurrency cap
- Both execute the same `reasoning_job` action — an autonomous Sonnet loop that may queue trade approvals
- A "schedule" is just a time trigger with a `cron` expression instead of a one-shot ISO datetime, and `recurring: true` behavior
- ADR-010 improved the scheduler runner with wall-clock timeouts, candle caching, parallel tool dispatch, and multi-approval accumulation — fixes that the heartbeat runner also needed but didn't have

Maintaining two pipelines created duplicated infrastructure and cognitive overhead: two storage files (`triggers.json` + `schedules.json`), two Claude tools (`register_trigger` + `register_schedule`), two route groups (`/api/triggers` + `/api/schedules`), and two UI panels (Triggers + Schedules).

---

## Decision

Collapse schedules into triggers. A cron-based schedule is represented as a `time` condition trigger with a `cron` field.

### Extended `TriggerCondition` time mode

```typescript
// Before
| { mode: "time"; fireAt: string }

// After
| { mode: "time"; at?: string; cron?: string; fireAt?: string }
// at   = one-shot ISO datetime (replaces fireAt)
// cron = recurring cron expression (was: schedule)
// fireAt preserved for backward compatibility with persisted data
```

### New `TriggerStatus` value

```typescript
export type TriggerStatus = "active" | "fired" | "expired" | "cancelled" | "paused";
```

`"paused"` allows cron triggers (and other recurring triggers) to be suspended without cancellation. The heartbeat skips paused triggers. Resuming recomputes `nextFireAt`.

### New `Trigger` fields

```typescript
recurring?: boolean;          // if true, trigger re-arms after firing (cron triggers always re-arm)
cooldownMs?: number;          // for recurring code/llm/event: min ms between firings
tradingDaysOnly?: boolean;    // skip non-NSE-trading days
staleAfterMs?: number;        // skip if overdue by more than this (time/cron only)
nextFireAt?: string;          // precomputed ISO fire time for cron triggers
lastFiredAt?: string;         // updated after each firing
```

### New `reasoning_job` action field

```typescript
{ type: "reasoning_job"; prompt?: string }
```

`prompt` is set at registration time. The runner uses it directly rather than auto-constructing a prompt from the trigger name and snapshot. All new triggers created via `register_trigger` include a `prompt`.

### Lifecycle rules

| Trigger kind | After firing |
|---|---|
| `time/at` or `time/fireAt` | Status → `"fired"` (one-shot, consumed) |
| `time/cron` | `nextFireAt` advances; status stays `"active"` |
| `code/llm/event` + `recurring: false` | Status → `"fired"` (existing behavior) |
| `code/llm/event` + `recurring: true` | `lastFiredAt` updated; status stays `"active"`; `cooldownMs` enforced |

### New audit outcome

```typescript
| { type: "reasoning_job_completed"; summary: string; approvalIds: string[]; durationMs: number }
```

Replaces the thin `reasoning_job_queued` for cron runs that complete fully. Historical `reasoning_job_queued` records remain valid.

---

## New infrastructure

### `heartbeat/cron-utils.ts`

Extracted from the deleted `scheduler/service.ts`:

```typescript
export function computeNextRunAt(cron: string, after?: Date): string
export function computeNextTradingRunAt(cron: string, after?: Date): string
export function evaluateCronTriggers(triggers: Trigger[], now: Date): { fired: string[]; stale: string[] }
```

`evaluateCronTriggers` separates stale triggers (overdue beyond `staleAfterMs`) from due triggers. Stale triggers advance `nextFireAt` without dispatching a reasoning job.

### Unified runner

ADR-010's scheduler runner performance improvements (wall-clock timeout, per-call Anthropic timeout, TtlCache for candle data, per-run result cache, parallel tool dispatch, multi-approval accumulation) are merged into `heartbeat/runner.ts`. The scheduler's `runner.ts` is deleted. All reasoning jobs — whether fired by a cron trigger, a one-shot time trigger, or a code/llm/event trigger — now use the same runner.

### Updated `TriggerStore`

```typescript
interface TriggerStore {
  list(opts?: { status?: TriggerStatus | TriggerStatus[] }): Promise<Trigger[]>;
  updateNextFireAt(id: string, nextFireAt: string, lastFiredAt?: string): Promise<void>;
  // existing methods unchanged
}
```

`list()` now accepts arrays: `{ status: ["active", "paused"] }` is used throughout to correctly include paused cron triggers in cascade operations and UI queries.

---

## API changes

| Old | New |
|---|---|
| `GET /api/schedules` | Removed — cron triggers served by `GET /api/triggers` |
| `GET /api/schedules/runs` | Removed — history in `GET /api/triggers/audit` |
| `POST /api/schedules/:id/pause` | `POST /api/triggers/:id/pause` |
| `POST /api/schedules/:id/resume` | `POST /api/triggers/:id/resume` |
| `DELETE /api/schedules/:id` | `DELETE /api/triggers/:id` |
| `GET /api/triggers` (active only) | `GET /api/triggers` (active + paused) |
| `GET /api/strategies/:id` `linkedSchedules` | Removed; cron triggers in `linkedTriggers` |

---

## Data migration

`migrateSchedulesToTriggers()` runs once at server startup (before storage init). It reads `schedules.json`, converts each entry to a `Trigger` with `condition: { mode: "time", cron }`, and appends to `triggers.json`. Idempotent — skips entries whose IDs already exist in `triggers.json`. Renames `schedules.json` → `schedules.json.migrated` on completion.

---

## Files deleted

```
backend/src/lib/scheduler/types.ts
backend/src/lib/scheduler/store.ts
backend/src/lib/scheduler/runner.ts
backend/src/lib/scheduler/service.ts
backend/src/routes/schedules.ts
frontend/src/components/SchedulesPanel.tsx
```

---

## Frontend

`TriggersPanel.tsx` is extended to display cron triggers:
- Cron expression badge + `nextFireAt` / `lastFiredAt` timestamps
- Trading-days-only badge
- Pause / Resume / Cancel buttons (call the new REST endpoints)
- `reasoning_job_completed` outcome in the history tab (shows summary + approval count)

The "Schedules" tab is removed from `ChatLayout.tsx`.

---

## Consequences

### Positive
- One concept instead of two: every autonomous run is a trigger. Simpler mental model.
- Halved storage, routes, tools, and UI surface.
- All reasoning jobs benefit from ADR-010's latency and cost improvements (previously only scheduled runs did).
- Pause/resume is now possible for any recurring trigger, not just schedules.
- Strategy archive correctly cascades over cron triggers alongside event triggers.

### Negative / trade-offs
- `schedule-runs.jsonl` historical data is not migrated (lossy; kept as-is on disk).
- `recurring` code/llm/event triggers with `cooldownMs` are a new pattern. Misuse (too-short cooldown) could run excessive reasoning jobs. The `cooldownMs` field is enforced by the heartbeat but requires Claude to set it sensibly at registration time.
- `staleAfterMs` only applies to `time/cron` triggers; there is no equivalent skip-if-stale for event triggers (those fire exactly when their condition is true, so staleness is not meaningful).
