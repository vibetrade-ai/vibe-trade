# ADR-011: Multi-Broker Adapter Interface

## Status
Accepted

## Context

VibeTrade was hard-wired to Dhan across 10+ files. `DhanClient` was passed directly into every tool handler; Dhan-specific strings (`"NSE_EQ"`, `"IDX_I"`, `"DH-901"`, `"TRADED"`) leaked throughout tools, heartbeat, scheduler, and chat routes. Adding any second broker (Zerodha, Groww, Hyperliquid) would have required surgical changes in every layer.

Concrete problems:

1. Tool handlers had `handler(args, client: DhanClient)` — every handler coupled to Dhan's API shape.
2. `lib/order-sync.ts` parsed raw Dhan JSON field names (`orderStatus`, `tradedPrice`, `rejectReason`) inline.
3. `heartbeat/snapshot.ts` and `heartbeat/service.ts` drove Dhan-specific batch-quote calls (NSE_EQ / IDX_I segmentation).
4. The index-constituent feature (niftyindices.com) was embedded inside `lib/dhan/instruments.ts` — inseparable from the Dhan security-ID resolution logic despite having no dependency on Dhan's API.
5. `DhanTokenExpiredError` was defined in `src/types.ts` (a global module) instead of alongside the broker code that throws it.

---

## Decisions

### 1. `BrokerAdapter` interface with normalized types

All broker interaction now goes through `lib/brokers/types.ts`, which defines:

- **Primitive types:** `OrderSide`, `OrderType`, `ProductType`, `CandleInterval`, `OrderStatus`, `AssetClass`
- **Value objects:** `Quote`, `Position`, `Funds`, `Order`, `OrderResult`, `OrderBook`, `Trade`, `Instrument`
- **Capabilities descriptor:** `BrokerCapabilities` — name, markets, asset classes, feature flags, available indices
- **`BrokerAdapter` interface** — 12 methods covering the full trading lifecycle

`Candle` is re-exported from `lib/indicators.ts` (timestamp as Unix number) to avoid a type divergence that would require touching the indicators library.

**Rationale:** A single interface is the minimal contract that tools, heartbeat, scheduler, and routes need to hold. Normalized types mean each consumer layer is written once and works across all brokers.

### 2. `DhanAdapter` encapsulates all Dhan-specific concerns

`lib/brokers/dhan/index.ts` is the only file that may contain Dhan-specific strings or logic. It is responsible for:

- Resolving NSE symbols → Dhan security IDs (via `brokers/dhan/instruments.ts`)
- Routing equity vs. index quotes to the correct segment (`NSE_EQ` / `IDX_I`)
- Batching equity quote requests in groups of 25 (Dhan's per-request limit)
- Mapping normalized `CandleInterval` (`"1m"`, `"1d"`) → Dhan interval strings (`"1"`, `"D"`)
- Translating `OrderParams` → Dhan order body
- Mapping Dhan order status strings (`"TRADED"`, `"PART_TRADED"`, `"REJECTED"`) → `OrderStatus`
- Throwing `BrokerAuthError` when Dhan returns error code `DH-901`

Nothing outside `lib/brokers/dhan/` ever sees `"NSE_EQ"`, `"IDX_I"`, `"TRADED"`, or `"DH-901"`.

### 3. `BrokerError` / `BrokerAuthError` replace `DhanTokenExpiredError`

Two error classes in `lib/brokers/errors.ts`:

- `BrokerError` — base class for all broker-originated errors
- `BrokerAuthError extends BrokerError` — token/auth expiry; replaces `DhanTokenExpiredError`

`DhanTokenExpiredError` is removed from `src/types.ts`. All three catch sites (`routes/chat.ts`, `routes/status.ts`, `lib/scheduler/runner.ts`) now catch `BrokerAuthError`.

**Rationale:** The error hierarchy belongs with the broker abstraction, not in a global types module.

### 4. `createBrokerAdapter()` factory in `lib/brokers/index.ts`

```typescript
createBrokerAdapter(broker: string, credentials: Record<string, string>): BrokerAdapter
```

`credentials.json` gains an optional `broker` string field (defaults to `"dhan"` for backward compatibility). `AppCredentialsStore.rebuildClients()` calls the factory instead of `new DhanClient(...)`. The resulting `BrokerAdapter` is propagated to heartbeat and scheduler via `setBrokerAdapter()`.

Adding a future broker requires implementing `BrokerAdapter` in `lib/brokers/{name}/` and adding one branch to the factory. No other files change.

### 5. Market data separated from broker data

Index constituent fetching from niftyindices.com moves to `lib/market-data/nse.ts`. This module has no broker dependency — it only fetches and caches CSV data from niftyindices.com. The `get_top_movers` and `get_index_constituents` tools import from here; the DhanAdapter does not.

The `get_top_movers` tool now:
1. Calls `getIndexConstituents(index)` → returns symbol strings (not security IDs)
2. Calls `broker.getQuote(symbols)` → DhanAdapter resolves security IDs internally, batches, returns `Quote[]`
3. Sorts by `changePercent` and returns gainers/losers

**Rationale:** niftyindices.com is a public market data source. Coupling it to Dhan's instrument master was an accidental dependency. Moving it out means Zerodha or Groww adapters can use the same constituent data without re-implementing the fetch.

### 6. CandleInterval normalized in tool schema

The `get_historical_data` and `compute_indicators` tool schemas change their `interval` enum from Dhan-specific strings (`"1"`, `"5"`, `"60"`, `"D"`) to normalized values (`"1m"`, `"5m"`, `"1h"`, `"1d"`). The DhanAdapter maps these internally.

This is a **breaking change to tool parameters** — any existing conversation history or schedules that pass `interval: "D"` will fail. Existing scheduled jobs using `get_historical_data` should be recreated with the new interval values.

### 7. Capability-driven tool availability

`ToolDefinition` gains an optional `requiresCapability` field. `getAllToolDefinitions(extra, broker)` filters out tools whose required capability is absent or empty. Currently annotated:

| Tool | Capability required |
|---|---|
| `get_historical_data` | `supportsHistoricalData` |
| `compute_indicators` | `supportsHistoricalData` |
| `get_market_depth` | `supportsMarketDepth` |
| `get_top_movers` | `availableIndices` (non-empty) |

All Dhan capabilities are `true` / non-empty, so no tools are filtered for Dhan. A crypto broker without historical data would have `get_historical_data` absent from the tool list automatically.

### 8. Dynamic broker block in the system prompt

`routes/chat.ts` now builds the system prompt dynamically from the connected broker's `BrokerCapabilities`:

```
<broker>
Name: Dhan
Markets: NSE, BSE
Asset classes: EQUITY, ETF, INDEX, FUTURES, OPTIONS
Historical data: true
Market depth: true
Available indices: NIFTY50, BANKNIFTY, ...
</broker>
```

This replaces the hardcoded `"connected to the user's Dhan brokerage account"` string.

### 9. `syncOrders` updated to use normalized types

`lib/brokers/dhan/order-sync.ts` (moved from `lib/order-sync.ts`) now calls `broker.getTradebook()` and `broker.getOrders()`, which return normalized `Trade[]` and `Order[]`. Dhan-specific field names (`tradedPrice`, `orderStatus`, `rejectReason`) are no longer accessed outside the adapter.

The `parseOrderStatus()` function (formerly in `lib/order-sync.ts`) is absorbed into `DhanAdapter.getOrderById()` and `DhanAdapter.getOrders()` — its Dhan-status-to-OrderStatus mapping lives inside the adapter.

---

## File Structure After Migration

```
backend/src/lib/
  brokers/
    errors.ts          — BrokerError, BrokerAuthError
    types.ts           — BrokerAdapter interface + all normalized types
    index.ts           — createBrokerAdapter() factory
    dhan/
      index.ts         — DhanAdapter implements BrokerAdapter
      client.ts        — DhanClient (internal HTTP wrapper)
      instruments.ts   — Dhan security ID resolution (CSV cache)
      candles.ts       — Dhan candle parsing + resolveInstrument
      order-sync.ts    — syncOrders(broker, store) using normalized types
  market-data/
    nse.ts             — niftyindices.com constituent fetching (broker-agnostic)
```

**Deleted:** `lib/dhan/` (entire directory), `lib/order-sync.ts`

---

## Files Changed

| File | Change |
|---|---|
| `lib/brokers/errors.ts` | **New** — BrokerError, BrokerAuthError |
| `lib/brokers/types.ts` | **New** — BrokerAdapter interface + normalized types |
| `lib/brokers/index.ts` | **New** — createBrokerAdapter() factory |
| `lib/brokers/dhan/index.ts` | **New** — DhanAdapter |
| `lib/brokers/dhan/client.ts` | Moved from `lib/dhan/client.ts`; throws BrokerAuthError |
| `lib/brokers/dhan/instruments.ts` | Moved from `lib/dhan/instruments.ts`; niftyindices.com logic removed |
| `lib/brokers/dhan/candles.ts` | Moved from `lib/dhan/candles.ts` |
| `lib/brokers/dhan/order-sync.ts` | Moved from `lib/order-sync.ts`; uses normalized broker types |
| `lib/market-data/nse.ts` | **New** — extracted from `lib/dhan/instruments.ts` |
| `lib/credentials.ts` | getBrokerAdapter(); broker field; propagates BrokerAdapter |
| `lib/tools.ts` | BrokerAdapter handler sig; normalized CandleInterval; capability filtering |
| `routes/chat.ts` | BrokerAuthError; dynamic system prompt with broker block |
| `routes/status.ts` | BrokerAuthError; broker name in response |
| `routes/settings.ts` | `broker` added to allowed POST fields |
| `routes/approvals.ts` | Uses broker.placeOrder() with normalized OrderParams |
| `lib/heartbeat/service.ts` | BrokerAdapter; setBrokerAdapter(); broker.placeOrder() for hard orders |
| `lib/heartbeat/snapshot.ts` | BrokerAdapter; uses normalized getPositions/getFunds/getQuote |
| `lib/heartbeat/runner.ts` | BrokerAdapter; passes broker to tool handlers |
| `lib/scheduler/runner.ts` | BrokerAuthError; CandleInterval; broker.getHistory() |
| `lib/scheduler/service.ts` | setBrokerAdapter() |
| `src/types.ts` | DhanTokenExpiredError removed |
| `frontend/.../SettingsPanel.tsx` | Broker selector UI (Dhan selected, disabled; "More coming soon") |
| **DELETED** `lib/dhan/` | Replaced by `lib/brokers/dhan/` |
| **DELETED** `lib/order-sync.ts` | Moved into broker adapter |

---

## Alternatives Considered

**Thin wrapper (pass-through adapter):** Return raw Dhan JSON from all adapter methods and just rename the class. Rejected — consumers would still be coupled to Dhan's field names. The normalized types are the point.

**External adapter packages (npm):** Separate npm packages per broker (e.g., `@vibetrade/dhan-adapter`). Rejected — adds release/versioning overhead with no benefit at current scale. In-repo adapters in `lib/brokers/{name}/` are discoverable, diffable, and require no publish step.

**Multiple active brokers simultaneously:** Allow routing different tool calls to different brokers. Rejected — significantly complicates the credentials model, the system prompt, and the approval flow. One active broker per session is the right model for a personal trading assistant.

**Registry pattern:** A `BrokerRegistry.register(name, factory)` class. Rejected — one `if` branch in a factory function is simpler and equally extensible at this scale.

---

## Consequences

**Adding a new broker** requires:
1. Implement `BrokerAdapter` in `lib/brokers/{name}/index.ts`
2. Add one `if (broker === "{name}")` branch to `createBrokerAdapter()`
3. Add the broker name as an option in the Settings UI

No changes to tools, chat, heartbeat, scheduler, or approval routes.

**Breaking change:** `get_historical_data` and `compute_indicators` interval values changed from `"1"/"D"` to `"1m"/"1d"`. Recreate any schedules or saved prompts that reference the old values.
