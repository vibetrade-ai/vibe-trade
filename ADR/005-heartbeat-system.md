# ADR-005: Heartbeat System — Autonomous Trigger Evaluation

## Status
Accepted

## Context

VibeTrade is entirely request-driven: every action originates from a user message over WebSocket. This means the user has to be present and actively watching the market for anything to happen. The goal of the heartbeat system is to let the user express intent in advance ("if RELIANCE drops below 2800, analyze the situation") and have the system act autonomously while the user is away.

The key design constraints:

- **Low LLM cost when nothing is happening** — most ticks should involve zero LLM calls
- **Explicit consent for money-moving actions** — hard orders (pre-authorized automated trades) must be approved by the user before they can fire
- **One-shot semantics** — triggers are consumed on fire; recurring behavior is composed by re-registering new triggers as an output of reasoning jobs
- **Auditable** — every trigger fire is recorded immutably with the exact snapshot at the time

---

## Decisions

### 1. Four condition evaluation modes: code, LLM, time, and event

```typescript
type TriggerCondition =
  | { mode: "code";  expression: string }   // JS expression; zero LLM cost per tick
  | { mode: "llm";   description: string }  // Haiku evaluates natural language
  | { mode: "time";  at?: string; cron?: string; fireAt?: string } // one-shot or recurring
  | { mode: "event"; kind: EventKind; ... } // structured event kinds (see ADR-009)
```

`time` mode supports both one-shot (`at`) and recurring (`cron`) variants. See ADR-011 for details on cron trigger lifecycle.

`event` mode adds 12 typed, enumerable kinds for position lifecycle, news/sentiment, macro volatility, and valuation thresholds. See ADR-009.

**Code mode** runs the expression inside `vm.runInNewContext` with a 500ms timeout against a sandboxed snapshot object. The sandbox exposes `quotes`, `positions`, `funds`, `nifty50`, `banknifty` — exactly the vocabulary of `SystemSnapshot`. Expression must return `true` to fire.

Examples:
```
quotes["RELIANCE"].lastPrice < 2800
nifty50.changePercent < -1.5 && quotes["HDFC"].changePercent < -2
positions.find(p => p.symbol === "TCS")?.pnlPercent > 8
```

**LLM mode** batches all LLM-mode triggers into a single Haiku call per tick, asking for a JSON array of fired IDs. One Haiku call per tick regardless of how many LLM triggers exist.

**Rationale:** Most conditions are numeric thresholds — code evaluation is deterministic, free, and fast. LLM mode exists for genuinely ambiguous conditions ("market sentiment looks bearish"). Defaulting to code keeps the steady-state cost at zero.

Claude chooses the mode at trigger registration time based on whether the condition is expressible as a code expression.

### 2. Two action types: reasoning_job and hard_order

```typescript
type TriggerAction =
  | { type: "reasoning_job" }                        // Sonnet loop; may queue approvals
  | { type: "hard_order"; tradeArgs: TradeArgs }     // executes immediately; pre-approved
```

**reasoning_job** fires an autonomous Sonnet loop (max 10 turns, non-streaming). The loop has access to all read-only tools plus four internal action tools: `register_soft_trigger`, `queue_trade_approval`, `queue_hard_trigger_approval`, `no_action`. The job does not interact with any WebSocket session — its output goes to the approval queue.

**hard_order** executes a trade directly when the condition fires — no LLM involved at fire time. The order parameters are fixed at registration time and cannot change.

**Rationale:** Separating analysis (reasoning_job) from execution (hard_order) lets users choose the level of automation they're comfortable with. Hard orders are zero-latency and zero-cost at fire time, which matters for time-sensitive conditions.

### 3. Hard triggers always require explicit user consent

Hard-order triggers can be created two ways:

- **Chat session**: Claude calls `register_trigger` with `action.type: "hard_order"` → the chat route intercepts before persisting and sends a `tool_approval_request` WebSocket message. The trigger is only saved if the user approves.
- **Reasoning job**: the runner calls `queue_hard_trigger_approval` → an approval item appears in the approval queue with a 30-minute expiry.

In both cases, the user sees exactly what order will be placed, under what condition, before consenting.

**Rationale:** Automated money-moving orders require explicit consent regardless of creation path. This is a hard invariant — no path exists that creates an active hard-order trigger without a human approval step.

### 4. Triggers are soft-deleted (full status lifecycle)

```typescript
type TriggerStatus = "active" | "fired" | "expired" | "cancelled" | "paused";
```

Triggers are never removed from `triggers.json`. They transition through statuses. `TriggerStore.list()` defaults to `status === "active"`. Full history is accessible via the audit store. Cron triggers use `"paused"` to suspend without cancellation; resuming recomputes `nextFireAt`.

`firedAt` and `outcomeId` (Dhan order ID or approval ID) are written on fire, creating a link from trigger → action → outcome.

**Rationale:** Soft-delete gives a complete record of what triggers have existed and what they did. Important for debugging when an automated order fires unexpectedly.

### 5. Immutable audit trail (append-only JSONL)

Every trigger fire writes a `TriggerAuditEntry` to `backend/data/trigger-audit.jsonl`:

```typescript
interface TriggerAuditEntry {
  id: string;
  triggerId: string;
  triggerName: string;
  firedAt: string;
  snapshotAtFire: SystemSnapshot;   // exact market state when condition fired
  action: TriggerAction;
  outcome:
    | { type: "hard_order_placed";    orderId: string }
    | { type: "hard_order_failed";    error: string }
    | { type: "reasoning_job_queued"; approvalId?: string }
    | { type: "reasoning_job_no_action"; reason: string };
}
```

`snapshotAtFire` captures the complete market state — quotes, positions, funds, indices — at the moment the condition was evaluated as true. This makes post-hoc analysis possible.

**Rationale:** Append-only JSONL is consistent with the conversation store pattern. Never pruned. The `snapshotAtFire` field is deliberately included even though it's large — understanding *why* a trigger fired requires knowing the exact market state.

### 6. Snapshot is built from watchSymbols declared at registration

Claude populates `watchSymbols` at trigger creation time — it lists every equity symbol the condition references. The snapshot builder uses this list to determine which security IDs to fetch. Indices (NIFTY50, BANKNIFTY) are always included.

```typescript
watchlist = new Set([
  ...activeTriggers.flatMap(t => t.watchSymbols),
  ...openPositions.map(p => p.symbol),  // from live positions fetch
  "NIFTY50", "BANKNIFTY"
])
```

**Rationale:** Declaring watchSymbols at registration time keeps the snapshot builder simple and deterministic — no parsing of expression strings or natural language descriptions. It also serves as documentation: reading a trigger record, you immediately know what data it depends on.

### 7. Heartbeat skips the snapshot if there are no active triggers

```typescript
if (activeTriggers.length === 0) {
  console.log("[heartbeat] no active triggers, skipping snapshot");
  return;
}
```

No Dhan API calls, no Haiku calls, no work done.

**Rationale:** The most common state is no triggers. Making the idle case truly free avoids unnecessary API load on Dhan's servers and keeps the heartbeat from failing silently when no credentials are needed.

### 8. Triggers carry optional inline context for reasoning jobs

```typescript
interface Trigger {
  // ...
  context?: string;  // optional goal/instruction injected into reasoning job prompt
}
```

When a reasoning job fires, if `trigger.context` is set it is injected as a `<trigger_context>` block in the system prompt — after the `<strategy>` block if one is present. This lets one-off triggers carry their own intent without requiring a full strategy entity, and lets strategy-linked triggers add specifics beyond the strategy plan.

`register_trigger` and the runner's `register_soft_trigger` tool both accept `context`. Child soft triggers created by a reasoning job inherit `strategyId` from their parent and can optionally carry forward a `context` of their own.

**Rationale:** Without `context`, triggers that fire without a strategy link have no goal — the reasoning job sees only raw market data and must infer intent from the trigger name and condition. `context` is a lightweight escape hatch: a free-text field where Claude or the user can express exactly what the job should decide and why, without the overhead of creating a strategy entity.

### 9. Reasoning jobs are fire-and-forget, capped at 3 concurrent (was §8)

Reasoning jobs run in the background. The service does not await their completion — it starts the job and moves on. A counter caps concurrency at 3 to prevent runaway Sonnet usage if many triggers fire simultaneously.

**Rationale:** A tick that awaits reasoning jobs would block the next tick. Fire-and-forget allows the heartbeat to remain on schedule. The 3-job cap is a safety bound — in practice, most ticks fire 0 or 1 triggers.

### 10. Approval queue is shared between chat-path and reasoning-job-path approvals

Both paths write to the same `ApprovalStore`. The frontend polls `GET /api/approvals` every 10 seconds and displays all pending items regardless of origin.

Approval items expire after 30 minutes if not acted on. `pruneExpired()` is called at the start of every tick.

**Rationale:** A single approval surface simplifies the UI — the user has one place to look. The 30-minute expiry prevents stale approvals from accumulating; trade proposals that expire are simply not acted on.

---

## Architecture diagram

```
User (chat)
    │  register_trigger (hard_order) → approval_request → user consent → trigger saved
    │  register_trigger (reasoning_job) → trigger saved directly
    ▼
TriggerStore (triggers.json, soft-delete)
    ▲                          │
    │                          ▼
HeartbeatService (60s tick)
    │
    ├─ buildSnapshot()  ← Dhan API (quotes, positions, funds)
    │
    ├─ evaluateCodeTriggers()  ← vm.runInNewContext, no LLM
    ├─ evaluateLlmTriggers()   ← single Haiku call
    │
    ├─ [hard_order fired]  → dhan.placeOrder() → TriggerAuditStore
    │
    └─ [reasoning_job fired]  → runReasoningJob() (Sonnet, 10 turns)
                                    │
                                    ├─ queue_trade_approval → ApprovalStore
                                    ├─ queue_hard_trigger_approval → ApprovalStore
                                    ├─ register_soft_trigger → TriggerStore
                                    └─ no_action → TriggerAuditStore

Frontend (10s poll)
    GET /api/approvals → ApprovalsPanel → user clicks Approve
    POST /api/approvals/:id/decide → dhan.placeOrder() or triggers.upsert()

    GET /api/triggers → TriggersPanel (active list)
    GET /api/triggers/audit → TriggersPanel (history tab)
```

---

## Cron triggers (see ADR-011)

Cron-based repeating runs are modelled as `time/cron` triggers — no separate scheduler. A cron trigger stays `"active"` after firing; its `nextFireAt` advances. The heartbeat handles both one-shot and cron time triggers in the same tick loop.

---

## File layout

```
backend/src/lib/heartbeat/
  types.ts              — all domain types (Trigger, SystemSnapshot, PendingApproval, TriggerAuditEntry)
  snapshot.ts           — buildSnapshot(dhan, triggers) → SystemSnapshot
  evaluator.ts          — evaluateCodeTriggers(), evaluateLlmTriggers()
  runner.ts             — runReasoningJob() — autonomous Sonnet loop
  service.ts            — HeartbeatService — start/stop, 60s tick

backend/src/lib/storage/local/
  trigger-store.ts      — triggers.json (soft-delete, in-memory cache)
  approval-store.ts     — approvals.json (in-memory cache)
  trigger-audit-store.ts — trigger-audit.jsonl (append-only)

backend/src/routes/
  approvals.ts          — GET /api/approvals, POST /api/approvals/:id/decide
  triggers.ts           — GET /api/triggers, GET /api/triggers/audit

frontend/src/
  hooks/useApprovals.ts           — 10s polling + decide()
  components/ApprovalsPanel.tsx   — pending approvals list
  components/ApprovalItem.tsx     — single card with expiry countdown
  components/TriggersPanel.tsx    — active triggers + audit history
```

---

## Consequences

- **Cost profile**: idle cost is zero (no triggers = no API calls). Active cost: one snapshot build per tick (several Dhan API calls) + optionally one Haiku call for LLM-mode triggers + Sonnet only when a reasoning_job fires.
- **Reliability**: `Promise.allSettled` in snapshot builder means a single failing API call (e.g. Dhan returning 400 on a symbol) does not abort the tick.
- **Auditability**: every automated action is traceable from trigger → fire event → approval/order.
- **Scaling**: the local store (JSON files) is appropriate for single-user localhost. A hosted deployment would replace the stores with Postgres tables — no other changes needed.
