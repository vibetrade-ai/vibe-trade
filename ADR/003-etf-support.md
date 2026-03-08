# ADR-003: ETF Support

## Status
Accepted

## Context
VibeTrade Phase 2 added market data tools for NSE equities and indices. ETFs (e.g. NIFTYBEES, GOLDBEES, BANKBEES) trade on NSE and were already reachable via existing tools (`get_quote`, `get_historical_data`, `place_order` all work since ETFs sit in the `NSE_EQ` segment), but the system had no way to identify whether a symbol was an ETF, filter search results by instrument type, or surface ETF-specific metadata (fund family, expense ratio, holdings, sector weightings).

---

## Decisions

### ETF identification via `SEM_INSTRUMENT_NAME` in the Dhan instrument master

The Dhan instrument master CSV includes a `SEM_INSTRUMENT_NAME` column that contains values like `"EQUITY"`, `"ETF"`, etc. `InstrumentRecord` is enriched with an `instrumentType` field populated from this column, and a new `isEtf(symbol)` export lets callers check a symbol's type after a cache lookup.

**Rationale:** No external call needed — the classification is already in the CSV we fetch on startup. Storing it on `InstrumentRecord` keeps the check O(1) after the initial parse.

### Display name from `SEM_CUSTOM_SYMBOL`, not `SEM_INSTRUMENT_NAME`

Previously, `name` on `InstrumentRecord` was populated from `SEM_INSTRUMENT_NAME`, which holds the instrument *type* string (`"EQUITY"`, `"ETF"`), not a human-readable name. The correct column for display names is `SEM_CUSTOM_SYMBOL` (falling back to `SM_SYMBOL_NAME`, then the type string).

**Rationale:** This was a latent bug — search results were returning `"EQUITY"` as the name for most instruments. Fixing it was a prerequisite for ETF search to return anything meaningful.

### `searchInstruments()` extended with a `type` filter

`searchInstruments(query, limit, type)` accepts `type: "equity" | "etf" | "all"` (default `"all"`) and filters `records` by `instrumentType` before slicing. The return type gains an `instrument_type` field so callers can see what they got.

**Rationale:** Without filtering, a search for `"gold"` returns a mix of gold-related equities and ETFs. Agents benefit from being able to say "find me gold ETFs" precisely.

### ETF-specific data via Yahoo Finance `fundProfile` and `topHoldings`

`getEtfInfo(symbol)` fetches Yahoo Finance modules `fundProfile`, `topHoldings`, and `summaryDetail` — the same `.NS` suffix convention as `getFundamentals`. It returns: fund family, category, legal type, expense ratio, net assets, NAV, 52-week range, portfolio P/E and P/B, top 10 holdings (symbol, name, weight), and sector weightings.

**Rationale:** These modules exist on Yahoo Finance for ETFs but not for stocks; conversely, `financialData` and `assetProfile` (used by `getFundamentals`) exist for stocks but not ETFs. They are genuinely different data shapes, so a separate function and tool is cleaner than a branching `getFundamentals`.

### `get_etf_info` tool guards against non-ETF symbols

The handler calls `isEtf(symbol)` before fetching and returns an error message if the symbol is not an ETF, pointing the user toward `search_instruments` with `type='etf'`.

**Rationale:** Calling Yahoo Finance's `fundProfile` module on a stock symbol returns empty/null data silently. The guard surfaces a clear error instead of a confusingly empty response.

### `get_fundamentals` description clarifies it is stocks-only

Added `"(stocks only, not ETFs)"` and a pointer to `get_etf_info` in the tool description.

**Rationale:** Without this, Claude may call `get_fundamentals` on an ETF symbol and get back mostly null fields with no explanation.

---

## Tool inventory after Phase 3

| Tool | Approval | Notes |
|------|----------|-------|
| `get_quote` | No | NSE equity + ETF, batch |
| `get_index_quote` | No | Any NSE index via IDX_I |
| `get_index_constituents` | No | |
| `get_positions` | No | |
| `get_funds` | No | |
| `get_orders` | No | |
| `place_order` | **Yes** | NSE equity + ETF |
| `cancel_order` | **Yes** | |
| `get_historical_data` | No | Equity + ETF + index |
| `compute_indicators` | No | Equity + ETF + index |
| `get_fundamentals` | No | Stocks only |
| `get_etf_info` | No | ETFs only; fund family, expense ratio, holdings |
| `fetch_news` | No | LiveMint RSS |
| `get_market_status` | No | |
| `is_trading_day` | No | |
| `get_upcoming_holidays` | No | |
| `search_instruments` | No | Supports `type` filter: all / equity / etf |
| `get_top_movers` | No | Any Nifty index |
| `get_market_depth` | No | |
| `compare_stocks` | No | Equity + index mixed |

## Consequences
- ETFs are now first-class instruments: identifiable, searchable by type, and carrying fund-specific metadata
- `SEM_CUSTOM_SYMBOL` fix improves display names for all instruments, not just ETFs
- `yahoo-finance2` `fundProfile`/`topHoldings` coverage for Indian ETFs is incomplete — many smaller ETFs return sparse or null data; the tool still returns what's available
