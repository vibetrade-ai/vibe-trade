# ADR-002: Phase 2 — Market Data, Index Support & Streaming Fix

## Status
Accepted

## Context
Phase 1 gave VibeTrade live quote, order, and position tools — enough to transact, but not enough to reason about the market. Phase 2 adds the data layer needed for analysis: historical candles, technical indicators, fundamentals, news, market status, instrument search, top movers, market depth, and stock comparison. It also extends all history/indicator/comparison tools to work with NSE indices (not just equities), and fixes a text cut-off bug in the streaming UI.

---

## Decisions

### External data sources for non-Dhan data

| Data | Source | Library |
|------|--------|---------|
| Fundamentals (PE, EPS, market cap, etc.) | Yahoo Finance | `yahoo-finance2` |
| Financial news | LiveMint RSS feeds | `rss-parser` |
| Technical indicators | Computed from Dhan OHLCV | `technicalindicators` |
| NSE holidays | Hardcoded for 2025–2026 | — |
| Index constituents | niftyindices.com CSV | `csv-parse/sync` |

**Rationale:** Dhan does not provide fundamentals or news. Yahoo Finance (`yahoo-finance2`) is the standard free source for NSE fundamentals via the `.NS` suffix convention. LiveMint RSS is publicly available and covers NSE-relevant news. The `technicalindicators` npm package provides RSI, MACD, Bollinger Bands, SMA, EMA, and ATR from raw OHLCV without requiring a Python bridge.

### Dynamic index constituent lookup via niftyindices.com

Index constituents (for `get_top_movers` and `get_index_constituents`) are fetched from niftyindices.com CSVs rather than hardcoded security ID arrays.

**URL derivation rule:** `NIFTY{X}` → `https://www.niftyindices.com/IndexConstituent/ind_nifty{x}list.csv`
(e.g. `NIFTYAUTO` → `ind_niftyautolist.csv`)

Two explicit exceptions where the symbol order doesn't match the filename:
- `BANKNIFTY` → `ind_niftybanklist.csv`
- `FINNIFTY` → `ind_niftyfinancelist.csv`

**Rationale:** A hardcoded security ID array was the Phase 1 approach. It had two problems: (1) it only covered Nifty 50, and (2) it contained duplicate IDs (RELIANCE/BPCL and DRREDDY/DIVISLAB mapped to the same ID). The derivation rule makes any NSE index automatically supported without maintaining a list, and the CSVs contain canonical symbols that resolve cleanly via the Dhan instrument master.

Both CSVs (instrument master and constituent lists) are cached with a 24h TTL. Constituent cache stores both resolved security IDs (for `get_top_movers`) and display info — symbol, company name, industry (for `get_index_constituents`) — in a single fetch.

### IDX_I segment support via `resolveInstrument()`

`get_historical_data`, `compute_indicators`, and `compare_stocks` previously hardcoded `NSE_EQ` and called `getSecurityId()`. They now call `resolveInstrument(symbol)` which:

1. Checks the `indexIdMap` populated from the Dhan instrument master's `IDX_I` rows (dynamic — covers all indices in the CSV)
2. Falls back to three hardcoded IDs (`NIFTY50=13`, `BANKNIFTY=25`, `FINNIFTY=27`) if IDX_I rows weren't parsed
3. Falls through to equity lookup (`NSE_EQ`) if neither matches

**Rationale:** Index instruments live in the `IDX_I` exchange segment in Dhan's API. Sending an index security ID with `NSE_EQ` returns an error. The resolver keeps the routing decision in one place and is transparent to the individual tool handlers. The hardcoded fallback ensures the three most-used indices always work even if CSV column naming changes.

### `get_index_quote` extended to all indices

Previously called `client.getIndexQuote()` which had a hardcoded three-index map. Now calls `resolveInstrument()` + `client.getQuote([securityId], "IDX_I")`, making it consistent with all other index-aware tools and supporting any index with an IDX_I entry.

### `get_index_constituents` as a dedicated tool

A `get_top_movers` call was being chosen by Claude to answer "what stocks are in Nifty Auto?" — semantically wrong (it fetches live quotes for all constituents and ranks them, when the user just wants the list).

A dedicated `get_index_constituents` tool returns `{symbol, name, industry}[]` directly from the niftyindices.com CSV without touching the quote API.

### React 18 batching fix for streaming cut-off

Responses were being truncated in the chat UI. Root cause: `appendText` read `currentAssistantIdRef.current` **inside** the `setItems` callback. React 18's automatic batching means state update callbacks run after the current microtask queue drains. When the final `text_delta` events and the `done` event arrive in the same tick, `done` nullifies the ref synchronously, and the batched `setItems` callbacks then read `null` and silently discard the trailing text.

**Fix:** Capture the ref value before queuing the `setItems` call:
```ts
// Before (broken): ref read inside callback — may see null by execution time
setItems(prev => { const id = currentAssistantIdRef.current; if (!id) return prev; ... });

// After (fixed): ref captured at event-arrival time
const id = currentAssistantIdRef.current;
if (!id) return;
setItems(prev => prev.map(item => item.id === id ? { ...item, content: item.content + text } : item));
```

## Tool inventory after Phase 2

| Tool | Approval | Notes |
|------|----------|-------|
| `get_quote` | No | NSE equity, batch |
| `get_index_quote` | No | Any NSE index via IDX_I |
| `get_index_constituents` | No | New in Phase 2 |
| `get_positions` | No | |
| `get_funds` | No | |
| `get_orders` | No | |
| `place_order` | **Yes** | |
| `cancel_order` | **Yes** | |
| `get_historical_data` | No | Equity + index |
| `compute_indicators` | No | Equity + index |
| `get_fundamentals` | No | Equity only |
| `fetch_news` | No | LiveMint RSS |
| `get_market_status` | No | |
| `is_trading_day` | No | |
| `get_upcoming_holidays` | No | |
| `search_instruments` | No | |
| `get_top_movers` | No | Any Nifty index |
| `get_market_depth` | No | |
| `compare_stocks` | No | Equity + index mixed |

## Consequences
- All analysis tools now work for indices, not just equities
- Any current or future Nifty index is automatically supported — no code changes needed to add a new index
- Streaming cut-off is resolved; trailing text from the final batch of `text_delta` events is no longer dropped
- `yahoo-finance2` has no SLA and may rate-limit under heavy use; fundamentals calls should be cached in a future phase
- NSE holidays are hardcoded through 2026 and will need updating annually
