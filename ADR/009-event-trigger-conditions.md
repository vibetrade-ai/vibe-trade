# ADR-009: Structured Event-Driven Trigger Conditions

## Status
Accepted

## Context

The heartbeat trigger system previously supported three condition modes:

- `code` — a JS expression evaluated against a market snapshot (quotes, positions, funds, indices)
- `llm` — a natural-language description evaluated by Haiku each tick
- `time` — a one-shot ISO timestamp

These covered price-based and qualitative conditions well. However, several important trading patterns couldn't be expressed cleanly:

- **Reacting to position lifecycle** — "when RELIANCE appears in my portfolio, chain a stop-loss trigger" requires position diffing across ticks, not just a snapshot read
- **News and sentiment** — "fire if INFY appears in new headlines" requires an RSS feed, deduplication across ticks, and optionally an LLM sentiment pass
- **Macro volatility** — "fire when VIX exceeds 20" requires fetching a symbol not in the standard snapshot
- **Valuation thresholds** — "fire when TCS PE drops below 25" requires fundamentals data that is expensive to fetch but can be aggressively cached
- **Index intraday moves** — "fire on a 2% Nifty rally" is possible in `code` mode today but requires knowing the internal variable names; a typed kind is clearer and safer

Expressing all of these in `code` mode was possible but required stuffing heterogeneous external data sources into the VM sandbox unconditionally — paying the fetch cost on every tick regardless of whether any trigger needed them.

---

## Decision

Add a 4th condition mode — `event` — with 12 typed, enumerable kinds. Complement it by enriching the `code` mode sandbox with the same underlying data so Claude can still write arbitrary cross-source expressions when needed.

### The two-layer model

**Layer 1 — Typed `event` mode**: structured, zero-boilerplate, efficient. Claude picks a kind and fills in its parameters. The heartbeat evaluator switches on `kind` and runs the appropriate check. No JS eval needed.

**Layer 2 — Enriched `code` mode**: the existing JS sandbox gains three new variables (`events`, `fundamentals`, `vix`) sourced from the same `EventDelta` infrastructure built for Layer 1. This preserves the expressiveness ceiling:

```js
// Chain two sources in a single expression
vix?.lastPrice > 20 && nifty50.changePercent < -1.5

// Fundamentals-gated entry
fundamentals["TATASTEEL"]?.pe_ratio < 10 && quotes["TATASTEEL"].changePercent < -2

// Specific news pattern
events.newHeadlines["companies"]?.some(h => h.title.includes("buyback"))
```

`llm` mode is unchanged. It remains the right choice for genuinely qualitative conditions that can't be encoded structurally.

### Event kinds

| Kind | Fires when | Key params |
|---|---|---|
| `position_opened` | Any of `symbols[]` enters the portfolio | `symbols` |
| `position_closed` | Any of `symbols[]` leaves the portfolio | `symbols` |
| `news_mention` | Any of `symbols[]` appears in new RSS headlines | `symbols`, `categories` |
| `sentiment_positive` | Haiku judges new headlines as positive for any watched symbol | `symbols`, `categories` |
| `sentiment_negative` | Haiku judges new headlines as negative for any watched symbol | `symbols`, `categories` |
| `pe_below` | Cached PE for `symbol` drops below `threshold` | `symbol`, `threshold` |
| `pe_above` | Cached PE for `symbol` rises above `threshold` | `symbol`, `threshold` |
| `fundamentals_changed` | Fresh fundamentals data arrived for `symbol` (cache miss or expiry) | `symbol` |
| `vix_above` | India VIX spot price exceeds `threshold` | `threshold` |
| `vix_below` | India VIX spot price drops below `threshold` | `threshold` |
| `nifty_drop_percent` | Nifty50 intraday change < –`threshold`% | `threshold` |
| `nifty_rise_percent` | Nifty50 intraday change > +`threshold`% | `threshold` |

`pe_above` and `vix_below` are included for symmetry: PE re-rating high signals an expensive exit, and VIX calming is a signal to deploy capital that is at least as actionable as VIX spiking.

---

## Data Infrastructure: `EventDelta`

A single `EventDelta` object is built once per tick (only when at least one event trigger is active) and shared across both the event evaluator and the code evaluator sandbox:

```typescript
interface EventDelta {
  newPositions: PositionEntry[];          // appeared since last tick
  closedPositions: PositionEntry[];       // disappeared since last tick
  newHeadlines: Record<string, NewsItem[]>; // category → headlines not seen before
  fundamentals: Record<string, Fundamentals | null>; // symbol → cached data
  vixQuote: QuoteEntry | null;
}
```

`HeartbeatService` maintains three pieces of persistent state across ticks to make this work:

- `previousPositions` — last tick's position list, diffed against current to find opens/closes
- `fundamentalsCache` — 30-minute TTL cache keyed by symbol; stale entries are refreshed, fresh ones are returned without a network call
- `seenHeadlineLinks` — set of RSS item links already seen; only genuinely new items flow into `newHeadlines`

### Conditional fetching

`buildEventDelta()` only fetches what active triggers actually need:

- RSS categories are collected from `news_mention` / `sentiment_positive` / `sentiment_negative` triggers; only those categories are fetched, once each
- Fundamentals are fetched only for symbols referenced by `pe_below` / `pe_above` / `fundamentals_changed` triggers, and only if the cache is stale
- VIX is fetched only if a `vix_above` or `vix_below` trigger is active
- Position diffing is always free (in-memory, no network)
- Nifty intraday change is always free (already in the snapshot)

An installation with no event triggers pays zero additional cost.

### Sentiment batching

`sentiment_positive` and `sentiment_negative` triggers are batched into a single Haiku call per tick, following the same pattern as `evaluateLlmTriggers`. The `kind` field is passed to the model so it can distinguish direction:

```
System: "Fire sentiment_negative triggers if the watched symbols have negative coverage.
         Fire sentiment_positive triggers if the watched symbols have positive coverage.
         Return ONLY a JSON array of trigger IDs. No markdown."
```

Haiku is only called if new (previously unseen) headlines arrived for the relevant categories — preventing repeated firing on stale content.

---

## Consequences

### Positive
- Claude can now register triggers for position lifecycle, news/sentiment, macro volatility, and valuation without writing JS or depending on internal variable names
- The 12 kinds are enumerable in the tool schema — Claude sees them as a finite, well-documented menu rather than an open-ended sandbox
- Fetch cost scales with active trigger needs, not with tick count. A `pe_below` trigger pays one Yahoo Finance call every 30 minutes, not every minute
- `code` mode users gain `events`, `fundamentals`, and `vix` in the sandbox at no additional schema complexity

### Negative / trade-offs
- `seenHeadlineLinks` grows unbounded over time. For the expected RSS volume (~100 items/day across 4 categories) this is negligible, but a TTL-based eviction or size cap should be added if the service runs for weeks without restart
- Fundamentals data from Yahoo Finance is delayed (not real-time). `pe_below` / `pe_above` fires on a 30-minute-stale PE, which is appropriate for medium-frequency strategies but wrong for intraday valuation plays
- Position diffing is accurate only as long as the heartbeat doesn't miss ticks. If the process restarts, `previousPositions` resets to `[]` and all current positions appear as "newly opened" on the next tick. Triggers should be idempotent or use a `position_opened` trigger with a `reasoning_job` action (which can check before acting)

---

## File Layout

```
backend/src/lib/heartbeat/
  types.ts              — EventKind, EventCondition, EventDelta added; TriggerCondition extended
  event-evaluator.ts    — NEW: evaluateEventTriggers(snapshot, delta, triggers)
  evaluator.ts          — evaluateCodeTriggers() gains optional EventDelta param; sandbox enriched
  service.ts            — previousPositions, fundamentalsCache, seenHeadlineLinks state;
                          buildEventDelta() private method; event triggers integrated into tick()

backend/src/lib/
  yahoo.ts              — getVixQuote() added (fetches ^INDIAVIX)
  tools.ts              — register_trigger condition schema extended with event mode fields
  heartbeat/runner.ts   — register_soft_trigger + queue_hard_trigger_approval condition schemas extended
```
