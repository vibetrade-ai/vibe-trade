import type Anthropic from "@anthropic-ai/sdk";
import { parseExpression } from "cron-parser";
import { DhanClient } from "./dhan/client.js";
import type { MemoryStore, TriggerStore, ScheduleStore, StrategyStore, TradeStore } from "./storage/index.js";
import type { TradeArgs } from "./heartbeat/types.js";
import {
  getSecurityId,
  getSecurityIds,
  searchInstruments,
  getIndexConstituents,
  getIndexConstituentInfo,
  getIndexSecurityId,
  isEtf,
} from "./dhan/instruments.js";
import { computeIndicators } from "./indicators.js";
import type { Candle } from "./indicators.js";
import { getFundamentals, getEtfInfo } from "./yahoo.js";
import { fetchNews } from "./news.js";
import { getMarketStatus, isTradingDay, getUpcomingHolidays } from "./market-calendar.js";

export interface ToolDefinition {
  definition: Anthropic.Tool;
  requiresApproval: boolean;
  handler: (args: Record<string, unknown>, client: DhanClient) => Promise<string>;
}

function describeApproval(tool: string, args: Record<string, unknown>): string {
  if (tool === "place_order") {
    return `Place a ${args.transaction_type} order for ${args.quantity} share(s) of ${args.symbol} (${args.order_type}${args.price ? ` @ ₹${args.price}` : ""})`;
  }
  if (tool === "cancel_order") {
    return `Cancel order ID: ${args.order_id}`;
  }
  return `Execute ${tool}`;
}

export function getApprovalDescription(tool: string, args: Record<string, unknown>): string {
  return describeApproval(tool, args);
}

// Helper: parse Dhan chart response into Candle[]
function parseDhanCandles(data: unknown): Candle[] {
  const d = data as Record<string, unknown>;
  const timestamps = (d["timestamp"] as number[]) ?? [];
  const opens = (d["open"] as number[]) ?? [];
  const highs = (d["high"] as number[]) ?? [];
  const lows = (d["low"] as number[]) ?? [];
  const closes = (d["close"] as number[]) ?? [];
  const volumes = (d["volume"] as number[]) ?? [];

  return timestamps.map((ts, i) => ({
    timestamp: ts,
    open: opens[i] ?? 0,
    high: highs[i] ?? 0,
    low: lows[i] ?? 0,
    close: closes[i] ?? 0,
    volume: volumes[i] ?? 0,
  }));
}

// Helper: compute date range strings
function dateRange(days: number): { fromDate: string; toDate: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return { fromDate: fmt(from), toDate: fmt(to) };
}

// Fallback security IDs for well-known indices (in case IDX_I not in instrument master)
const FALLBACK_INDEX_IDS: Record<string, string> = {
  NIFTY50:   "13",
  BANKNIFTY: "25",
  FINNIFTY:  "27",
};

// Resolve a symbol to its security ID, exchange segment, and instrument type.
// Checks the Dhan IDX_I map first (covers all indices in the instrument master),
// then falls back to hardcoded IDs for the 3 major indices, then treats as equity.
async function resolveInstrument(symbol: string): Promise<{
  securityId: string;
  exchangeSegment: "NSE_EQ" | "IDX_I";
  instrument: "EQUITY" | "INDEX";
}> {
  let normalized = symbol.toUpperCase().replace(/[\s\-_]/g, "");
  if (normalized === "NIFTYBANK") normalized = "BANKNIFTY";
  if (normalized === "NIFTY") normalized = "NIFTY50";

  // Try Dhan instrument master IDX_I entries first (dynamic — covers all indices)
  let securityId = await getIndexSecurityId(normalized);
  // Fallback for well-known indices in case IDX_I rows weren't parsed
  if (!securityId) securityId = FALLBACK_INDEX_IDS[normalized];

  if (securityId) {
    return { securityId, exchangeSegment: "IDX_I", instrument: "INDEX" };
  }

  const equityId = await getSecurityId(symbol);
  return { securityId: equityId, exchangeSegment: "NSE_EQ", instrument: "EQUITY" };
}

export const TOOLS: Record<string, ToolDefinition> = {
  get_quote: {
    requiresApproval: false,
    definition: {
      name: "get_quote",
      description: "Get live LTP (last traded price) and OHLC for one or more NSE equity or ETF symbols.",
      input_schema: {
        type: "object",
        properties: {
          symbols: {
            type: "array",
            items: { type: "string" },
            description: "List of NSE equity or ETF trading symbols, e.g. ['RELIANCE', 'TCS', 'NIFTYBEES', 'GOLDBEES']",
          },
        },
        required: ["symbols"],
      },
    },
    handler: async (args, client) => {
      const symbols = args.symbols as string[];
      const secIds = await getSecurityIds(symbols);
      const result = await client.getQuote(Object.values(secIds));
      return JSON.stringify(result, null, 2);
    },
  },

  get_index_quote: {
    requiresApproval: false,
    definition: {
      name: "get_index_quote",
      description:
        "Get live price for any NSE index, e.g. NIFTY50, BANKNIFTY, FINNIFTY, NIFTYIT, NIFTYAUTO, NIFTYPHARMA, NIFTYFMCG.",
      input_schema: {
        type: "object",
        properties: {
          index: {
            type: "string",
            description: "NSE index name, e.g. NIFTY50, BANKNIFTY, NIFTYIT, NIFTYAUTO",
          },
        },
        required: ["index"],
      },
    },
    handler: async (args, client) => {
      const { securityId, exchangeSegment } = await resolveInstrument(args.index as string);
      if (exchangeSegment !== "IDX_I") {
        return JSON.stringify({ error: `'${args.index}' is not a recognised index symbol.` });
      }
      const result = await client.getQuote([securityId], "IDX_I");
      return JSON.stringify(result, null, 2);
    },
  },

  get_index_constituents: {
    requiresApproval: false,
    definition: {
      name: "get_index_constituents",
      description:
        "List all constituent stocks of an NSE index with their company name and industry. Works for any Nifty index, e.g. NIFTY50, BANKNIFTY, NIFTYAUTO, NIFTYIT, NIFTYPHARMA, NIFTY500.",
      input_schema: {
        type: "object",
        properties: {
          index: {
            type: "string",
            description: "NSE index name, e.g. NIFTY50, NIFTYAUTO, BANKNIFTY, NIFTYIT",
          },
        },
        required: ["index"],
      },
    },
    handler: async (args, _client) => {
      const constituents = await getIndexConstituentInfo(args.index as string);
      return JSON.stringify({ index: (args.index as string).toUpperCase(), count: constituents.length, constituents }, null, 2);
    },
  },

  get_positions: {
    requiresApproval: false,
    definition: {
      name: "get_positions",
      description: "Get all open positions in the Dhan account.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    handler: async (_args, client) => {
      const result = await client.getPositions();
      return JSON.stringify(result, null, 2);
    },
  },

  get_funds: {
    requiresApproval: false,
    definition: {
      name: "get_funds",
      description: "Get available balance, used margin, and day P&L for the Dhan account.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    handler: async (_args, client) => {
      const result = await client.getFunds();
      return JSON.stringify(result, null, 2);
    },
  },

  get_orders: {
    requiresApproval: false,
    definition: {
      name: "get_orders",
      description: "Get today's full order book from the Dhan account.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    handler: async (_args, client) => {
      const result = await client.getOrders();
      return JSON.stringify(result, null, 2);
    },
  },

  place_order: {
    requiresApproval: true,
    definition: {
      name: "place_order",
      description: "Place a BUY or SELL order on NSE equity or ETF. Requires user approval before execution.",
      input_schema: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "NSE equity or ETF trading symbol, e.g. 'RELIANCE', 'NIFTYBEES'",
          },
          transaction_type: {
            type: "string",
            enum: ["BUY", "SELL"],
            description: "BUY or SELL",
          },
          quantity: {
            type: "number",
            description: "Number of shares",
          },
          order_type: {
            type: "string",
            enum: ["MARKET", "LIMIT"],
            description: "MARKET or LIMIT order",
          },
          price: {
            type: "number",
            description: "Limit price (required for LIMIT orders, ignored for MARKET)",
          },
          strategy_id: {
            type: "string",
            description: "Optional strategy ID to associate this trade with a strategy's records",
          },
          note: {
            type: "string",
            description: "Optional reasoning or context for this trade (stored in trade history)",
          },
        },
        required: ["symbol", "transaction_type", "quantity", "order_type"],
      },
    },
    handler: async (args, client) => {
      const symbol = args.symbol as string;
      const securityId = await getSecurityId(symbol);
      const result = await client.placeOrder({
        symbol,
        securityId,
        transactionType: args.transaction_type as "BUY" | "SELL",
        quantity: args.quantity as number,
        orderType: args.order_type as "MARKET" | "LIMIT",
        price: args.price as number | undefined,
      });
      return JSON.stringify(result, null, 2);
    },
  },

  cancel_order: {
    requiresApproval: true,
    definition: {
      name: "cancel_order",
      description: "Cancel a pending order by order ID. Requires user approval before execution.",
      input_schema: {
        type: "object",
        properties: {
          order_id: {
            type: "string",
            description: "The Dhan order ID to cancel",
          },
        },
        required: ["order_id"],
      },
    },
    handler: async (args, client) => {
      const result = await client.cancelOrder(args.order_id as string);
      return JSON.stringify(result, null, 2);
    },
  },

  // ── NEW MARKET DATA TOOLS ─────────────────────────────────────────────────

  get_historical_data: {
    requiresApproval: false,
    definition: {
      name: "get_historical_data",
      description:
        "Get historical OHLCV candles for an NSE equity, ETF, or index symbol (e.g. NIFTY50, BANKNIFTY, NIFTYBEES). Supports intraday (1/5/15/60 min) and daily intervals.",
      input_schema: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "NSE trading symbol or index name, e.g. 'RELIANCE', 'NIFTY50', 'BANKNIFTY'",
          },
          interval: {
            type: "string",
            enum: ["1", "5", "15", "25", "60", "D"],
            description: "Candle interval. '1','5','15','25','60' for intraday minutes; 'D' for daily.",
          },
          days: {
            type: "number",
            description: "Number of past days of data to fetch (max 365 for daily, 30 for intraday).",
          },
        },
        required: ["symbol", "interval", "days"],
      },
    },
    handler: async (args, client) => {
      const symbol = args.symbol as string;
      const interval = args.interval as "1" | "5" | "15" | "25" | "60" | "D";
      const days = Math.min(args.days as number, interval === "D" ? 365 : 30);
      const { securityId, exchangeSegment, instrument } = await resolveInstrument(symbol);
      const { fromDate, toDate } = dateRange(days);
      const raw = await client.getHistory(securityId, interval, fromDate, toDate, exchangeSegment, instrument);
      const candles = parseDhanCandles(raw);
      // Return last 200 candles max
      return JSON.stringify(candles.slice(-200), null, 2);
    },
  },

  compute_indicators: {
    requiresApproval: false,
    definition: {
      name: "compute_indicators",
      description:
        "Compute technical indicators (RSI, MACD, Bollinger Bands, SMA, EMA, ATR, VWAP) for an NSE equity or index symbol (e.g. NIFTY50, BANKNIFTY).",
      input_schema: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "NSE trading symbol or index name, e.g. 'TCS', 'NIFTY50', 'BANKNIFTY'",
          },
          interval: {
            type: "string",
            enum: ["1", "5", "15", "25", "60", "D"],
            description: "Candle interval. '1','5','15','25','60' for intraday minutes; 'D' for daily.",
          },
          days: {
            type: "number",
            description: "Number of past days of data to base calculations on.",
          },
        },
        required: ["symbol", "interval", "days"],
      },
    },
    handler: async (args, client) => {
      const symbol = args.symbol as string;
      const interval = args.interval as "1" | "5" | "15" | "25" | "60" | "D";
      const days = Math.min(args.days as number, interval === "D" ? 365 : 30);
      const { securityId, exchangeSegment, instrument } = await resolveInstrument(symbol);
      const { fromDate, toDate } = dateRange(days);
      const raw = await client.getHistory(securityId, interval, fromDate, toDate, exchangeSegment, instrument);
      const candles = parseDhanCandles(raw);
      if (candles.length < 26) {
        return JSON.stringify({ error: "Insufficient data for indicators. Try more days or a broader interval." });
      }
      const result = computeIndicators(candles);
      return JSON.stringify({ symbol, interval, candles_analyzed: candles.length, indicators: result }, null, 2);
    },
  },

  get_fundamentals: {
    requiresApproval: false,
    definition: {
      name: "get_fundamentals",
      description:
        "Get fundamental data for an NSE equity (stocks only, not ETFs): PE ratio, EPS, growth, ROE, debt/equity, market cap, sector, 52-week range. For ETFs use get_etf_info instead.",
      input_schema: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "NSE equity trading symbol, e.g. 'INFY'",
          },
        },
        required: ["symbol"],
      },
    },
    handler: async (args, _client) => {
      const result = await getFundamentals(args.symbol as string);
      return JSON.stringify(result, null, 2);
    },
  },

  get_etf_info: {
    requiresApproval: false,
    definition: {
      name: "get_etf_info",
      description:
        "Get ETF-specific information: fund family, category, expense ratio, AUM, NAV, top holdings, and sector weightings. For ETFs like NIFTYBEES, GOLDBEES, JUNIORBEES, BANKBEES, LIQUIDBEES.",
      input_schema: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "NSE ETF symbol, e.g. 'NIFTYBEES', 'GOLDBEES'",
          },
        },
        required: ["symbol"],
      },
    },
    handler: async (args, _client) => {
      const symbol = args.symbol as string;
      if (!(await isEtf(symbol))) {
        return JSON.stringify({ error: `'${symbol}' is not an ETF. Use search_instruments with type='etf' to find ETF symbols.` });
      }
      return JSON.stringify(await getEtfInfo(symbol), null, 2);
    },
  },

  fetch_news: {
    requiresApproval: false,
    definition: {
      name: "fetch_news",
      description: "Fetch latest financial news headlines from LiveMint RSS feeds.",
      input_schema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["markets", "economy", "companies", "finance"],
            description: "News category. Default: 'markets'.",
          },
          limit: {
            type: "number",
            description: "Maximum number of headlines to return (1–20). Default: 10.",
          },
        },
        required: [],
      },
    },
    handler: async (args, _client) => {
      const category = (args.category as "markets" | "economy" | "companies" | "finance") ?? "markets";
      const limit = Math.min(Math.max((args.limit as number) ?? 10, 1), 20);
      const news = await fetchNews(category, limit);
      return JSON.stringify(news, null, 2);
    },
  },

  get_market_status: {
    requiresApproval: false,
    definition: {
      name: "get_market_status",
      description:
        "Get current NSE market status: session phase (pre_market/open/post_market/closed), time in IST, minutes to open/close, and next market open.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    handler: async (_args, _client) => {
      const status = getMarketStatus();
      return JSON.stringify(status, null, 2);
    },
  },

  is_trading_day: {
    requiresApproval: false,
    definition: {
      name: "is_trading_day",
      description: "Check if a given date (or today) is an NSE trading day.",
      input_schema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "ISO date string (YYYY-MM-DD). Defaults to today in IST if not provided.",
          },
        },
        required: [],
      },
    },
    handler: async (args, _client) => {
      const result = isTradingDay(args.date as string | undefined);
      return JSON.stringify(result, null, 2);
    },
  },

  get_upcoming_holidays: {
    requiresApproval: false,
    definition: {
      name: "get_upcoming_holidays",
      description: "Get the next N upcoming NSE market holidays.",
      input_schema: {
        type: "object",
        properties: {
          n: {
            type: "number",
            description: "Number of upcoming holidays to return. Default: 5.",
          },
        },
        required: [],
      },
    },
    handler: async (args, _client) => {
      const n = Math.min(Math.max((args.n as number) ?? 5, 1), 20);
      const holidays = getUpcomingHolidays(n);
      return JSON.stringify(holidays, null, 2);
    },
  },

  search_instruments: {
    requiresApproval: false,
    definition: {
      name: "search_instruments",
      description: "Search NSE equity or ETF instruments by ticker symbol or company/fund name (fuzzy/substring match). Use type='etf' to filter ETFs only.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query, e.g. 'bank', 'reliance', 'gold', 'HDFC'",
          },
          limit: {
            type: "number",
            description: "Maximum results to return. Default: 20.",
          },
          type: {
            type: "string",
            enum: ["all", "equity", "etf"],
            description: "Filter by instrument type. Default: 'all'. Use 'etf' to list ETFs only.",
          },
        },
        required: ["query"],
      },
    },
    handler: async (args, _client) => {
      const results = await searchInstruments(
        args.query as string,
        (args.limit as number) ?? 20,
        (args.type as "equity" | "etf" | "all") ?? "all"
      );
      return JSON.stringify(results, null, 2);
    },
  },

  get_top_movers: {
    requiresApproval: false,
    definition: {
      name: "get_top_movers",
      description: "Get top N gainers and losers from a Nifty index basket based on today's price change.",
      input_schema: {
        type: "object",
        properties: {
          n: {
            type: "number",
            description: "Number of top gainers and losers to return each. Default: 5.",
          },
          index: {
            type: "string",
            description:
              "NSE index to scan. Any valid Nifty index name, e.g. NIFTY50, BANKNIFTY, NIFTYIT, NIFTYAUTO, NIFTYFMCG, NIFTYPHARMA, NIFTY100, NIFTY500, NIFTYMIDCAP100, NIFTYNEXT50, NIFTYSMALLCAP100. Default: NIFTY50.",
          },
        },
        required: [],
      },
    },
    handler: async (args, client) => {
      const n = Math.min(Math.max((args.n as number) ?? 5, 1), 25);
      const index = (args.index as string) ?? "NIFTY50";
      const securityIds = await getIndexConstituents(index);

      // Fetch quotes in batches of 25
      const batchSize = 25;
      const allData: unknown[] = [];

      for (let i = 0; i < securityIds.length; i += batchSize) {
        const batch = securityIds.slice(i, i + batchSize);
        const result = await client.getQuote(batch);
        // New format: result.data["NSE_EQ"] is an object keyed by securityId string
        const nseEq = ((result as Record<string, unknown>)["data"] as Record<string, unknown>)?.["NSE_EQ"] as Record<string, Record<string, unknown>> | undefined;
        if (nseEq && typeof nseEq === "object") {
          for (const [secId, q] of Object.entries(nseEq)) {
            allData.push({ ...q, securityId: secId });
          }
        }
      }

      type QuoteItem = {
        tradingSymbol: string;
        lastPrice: number;
        previousClose: number;
        pct_change: number;
      };

      const items: QuoteItem[] = (allData as Array<Record<string, unknown>>)
        .filter((q) => q["last_price"] && (q["ohlc"] as Record<string, number> | undefined)?.["close"])
        .map((q) => {
          const lp = q["last_price"] as number;
          const pc = (q["ohlc"] as Record<string, number>)["close"];
          return {
            tradingSymbol: (q["tradingSymbol"] as string) ?? String(q["securityId"]),
            lastPrice: lp,
            previousClose: pc,
            pct_change: +((lp - pc) / pc * 100).toFixed(2),
          };
        });

      items.sort((a, b) => b.pct_change - a.pct_change);
      const gainers = items.slice(0, n);
      const losers = items.slice(-n).reverse();

      return JSON.stringify({ index, gainers, losers }, null, 2);
    },
  },

  get_market_depth: {
    requiresApproval: false,
    definition: {
      name: "get_market_depth",
      description: "Get the full bid/ask order book (market depth) for an NSE equity symbol.",
      input_schema: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "NSE equity trading symbol, e.g. 'HDFC'",
          },
        },
        required: ["symbol"],
      },
    },
    handler: async (args, client) => {
      const symbol = args.symbol as string;
      const securityId = await getSecurityId(symbol);
      const result = await client.getMarketDepth(securityId);
      return JSON.stringify(result, null, 2);
    },
  },

  compare_stocks: {
    requiresApproval: false,
    definition: {
      name: "compare_stocks",
      description:
        "Side-by-side comparison of 2–5 NSE equities or indices: live price, PE, EPS, market cap, 52-week range, sector. Indices (e.g. NIFTY50, BANKNIFTY) skip fundamentals.",
      input_schema: {
        type: "object",
        properties: {
          symbols: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 5,
            description: "2–5 NSE equity symbols or index names to compare, e.g. ['RELIANCE', 'TCS', 'NIFTY50']",
          },
        },
        required: ["symbols"],
      },
    },
    handler: async (args, client) => {
      const symbols = args.symbols as string[];
      if (symbols.length < 2 || symbols.length > 5) {
        return JSON.stringify({ error: "Provide 2–5 symbols for comparison." });
      }

      // Resolve each symbol to its segment
      const resolved = await Promise.all(symbols.map((s) => resolveInstrument(s)));

      // Group by segment for batched quote fetches
      const equityIds: string[] = [];
      const indexIds: string[] = [];
      resolved.forEach(({ securityId, exchangeSegment }) => {
        if (exchangeSegment === "IDX_I") indexIds.push(securityId);
        else equityIds.push(securityId);
      });

      // Fetch quotes per segment, merge into quoteMap (keyed by securityId)
      const quoteMap: Record<string, Record<string, unknown>> = {};
      const extractQuotes = (result: unknown, segKey: string) => {
        // New format: result.data[segKey] is an object keyed by securityId string
        const segData = ((result as Record<string, unknown>)["data"] as Record<string, unknown>)?.[segKey] as Record<string, Record<string, unknown>> | undefined;
        if (segData && typeof segData === "object") {
          for (const [secId, q] of Object.entries(segData)) {
            // Store normalized entry keyed by securityId
            const normalized: Record<string, unknown> = {
              securityId: secId,
              lastPrice: q["last_price"],
              previousClose: (q["ohlc"] as Record<string, number> | undefined)?.["close"],
              open: (q["ohlc"] as Record<string, number> | undefined)?.["open"],
              high: (q["ohlc"] as Record<string, number> | undefined)?.["high"],
              low: (q["ohlc"] as Record<string, number> | undefined)?.["low"],
            };
            quoteMap[secId] = normalized;
          }
        }
      };

      await Promise.all([
        equityIds.length > 0
          ? client.getQuote(equityIds, "NSE_EQ").then((r) => extractQuotes(r, "NSE_EQ"))
          : Promise.resolve(),
        indexIds.length > 0
          ? client.getQuote(indexIds, "IDX_I").then((r) => extractQuotes(r, "IDX_I"))
          : Promise.resolve(),
      ]);

      // Fetch fundamentals only for equities
      const fundamentalsArr = await Promise.all(
        symbols.map((s, i) =>
          resolved[i].instrument === "EQUITY"
            ? getFundamentals(s).catch(() => ({ symbol: s }))
            : Promise.resolve(null)
        )
      );

      const comparison = symbols.map((sym, i) => {
        const { securityId } = resolved[i];
        const quote = quoteMap[securityId] ?? quoteMap[sym.toUpperCase()] ?? {};
        const fund = fundamentalsArr[i] as Record<string, unknown> | null;
        return {
          symbol: sym.toUpperCase(),
          type: resolved[i].instrument,
          last_price: quote["lastPrice"],
          change_pct: quote["previousClose"]
            ? +(((quote["lastPrice"] as number) - (quote["previousClose"] as number)) / (quote["previousClose"] as number) * 100).toFixed(2)
            : undefined,
          ...(fund
            ? {
                pe_ratio: fund["pe_ratio"],
                forward_pe: fund["forward_pe"],
                eps: fund["eps"],
                market_cap: fund["market_cap"],
                sector: fund["sector"],
                industry: fund["industry"],
                fifty_two_week_high: fund["fifty_two_week_high"],
                fifty_two_week_low: fund["fifty_two_week_low"],
                roe: fund["roe"],
                debt_to_equity: fund["debt_to_equity"],
              }
            : {}),
        };
      });

      return JSON.stringify(comparison, null, 2);
    },
  },
};

export function getAllToolDefinitions(extra: ToolDefinition[] = []): Anthropic.Tool[] {
  return [...Object.values(TOOLS), ...extra].map((t) => t.definition);
}

export function createUpdateMemoryTool(store: MemoryStore): ToolDefinition {
  return {
    requiresApproval: false,
    definition: {
      name: "update_memory",
      description:
        "Persist a note about the user to long-term memory. Call this whenever you learn something stable about the user's preferences, risk style, or analysis approach, or when the user explicitly asks you to remember or forget something. The content you provide completely replaces the current memory — always include everything you want to retain.",
      input_schema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "Full replacement content for MEMORY.md. Use Markdown. Include all preferences you want to remember — this overwrites the previous file.",
          },
        },
        required: ["content"],
      },
    },
    handler: async (args) => {
      const content = args["content"] as string;
      await store.write(content);
      return "Memory updated.";
    },
  };
}

export function createRegisterTriggerTool(store: TriggerStore): ToolDefinition {
  return {
    requiresApproval: false, // soft triggers; hard triggers get intercepted in chat.ts
    definition: {
      name: "register_trigger",
      description: `Register a conditional market trigger. When the condition fires, it executes the action automatically.

Two condition modes:
- "code": A JavaScript expression evaluated against the snapshot. Use variables: quotes["SYMBOL"].lastPrice/changePercent/open/high/low, positions (array with .symbol/.quantity/.pnlPercent/.unrealizedPnl), funds.availableBalance, nifty50.lastPrice/changePercent, banknifty.lastPrice/changePercent. Expression must return exactly true to fire.
- "llm": Natural language condition evaluated by an AI model each tick. Use for nuanced conditions.

Two action types:
- "reasoning_job": Fires an autonomous Sonnet analysis loop that can queue trade proposals.
- "hard_order": Executes a trade immediately when condition fires. REQUIRES user approval — you will receive a prompt.

watchSymbols: List every symbol referenced in the condition so the snapshot builder fetches them.

Examples:
- condition: { mode: "code", expression: "quotes['RELIANCE'].lastPrice < 2800" }
- condition: { mode: "code", expression: "nifty50.changePercent < -1.5" }
- condition: { mode: "llm", description: "Market sentiment looks bearish based on news and price action" }`,
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Human-readable trigger name" },
          scope: { type: "string", enum: ["symbol", "market", "portfolio"] },
          watchSymbols: {
            type: "array",
            items: { type: "string" },
            description: "All NSE symbols referenced in the condition (for snapshot fetching). Use [] for market/portfolio conditions.",
          },
          condition: {
            type: "object",
            description: "Trigger condition",
            properties: {
              mode: { type: "string", enum: ["code", "llm", "time"] },
              expression: { type: "string", description: "JS expression (code mode)" },
              description: { type: "string", description: "Natural language condition (llm mode)" },
              fireAt: { type: "string", description: "ISO timestamp for time-mode triggers — fires once when Date.now() >= fireAt" },
            },
            required: ["mode"],
          },
          action: {
            type: "object",
            description: "Action to take when condition fires",
            properties: {
              type: { type: "string", enum: ["reasoning_job", "hard_order"] },
              tradeArgs: {
                type: "object",
                description: "Required for hard_order",
                properties: {
                  symbol: { type: "string" },
                  transaction_type: { type: "string", enum: ["BUY", "SELL"] },
                  quantity: { type: "number" },
                  order_type: { type: "string", enum: ["MARKET", "LIMIT"] },
                  price: { type: "number" },
                },
                required: ["symbol", "transaction_type", "quantity", "order_type"],
              },
            },
            required: ["type"],
          },
          expiresAt: { type: "string", description: "ISO date string — trigger auto-expires if condition never fires by this time" },
          strategy_id: { type: "string", description: "Optional strategy ID to link this trigger to a strategy" },
        },
        required: ["name", "scope", "watchSymbols", "condition", "action"],
      },
    },
    handler: async (args) => {
      // Hard-order triggers are intercepted in chat.ts before this handler runs
      const { randomUUID } = await import("crypto");
      const trigger = {
        id: randomUUID(),
        name: args.name as string,
        scope: args.scope as "symbol" | "market" | "portfolio",
        watchSymbols: args.watchSymbols as string[],
        condition: args.condition as { mode: "code"; expression: string } | { mode: "llm"; description: string },
        action: args.action as { type: "reasoning_job" } | { type: "hard_order"; tradeArgs: TradeArgs },
        expiresAt: args.expiresAt as string | undefined,
        createdAt: new Date().toISOString(),
        active: true,
        status: "active" as const,
        ...(args.strategy_id ? { strategyId: args.strategy_id as string } : {}),
      };
      await store.upsert(trigger);
      return JSON.stringify({ success: true, triggerId: trigger.id, name: trigger.name });
    },
  };
}

export function createCancelTriggerTool(store: TriggerStore): ToolDefinition {
  return {
    requiresApproval: false,
    definition: {
      name: "cancel_trigger",
      description: "Cancel an active trigger by ID. The trigger will be soft-deleted (status set to cancelled).",
      input_schema: {
        type: "object",
        properties: {
          trigger_id: { type: "string", description: "The trigger ID to cancel" },
        },
        required: ["trigger_id"],
      },
    },
    handler: async (args) => {
      const id = args.trigger_id as string;
      const trigger = await store.get(id);
      if (!trigger) return JSON.stringify({ error: `Trigger ${id} not found` });
      if (trigger.status !== "active") return JSON.stringify({ error: `Trigger ${id} is already ${trigger.status}` });
      await store.setStatus(id, "cancelled");
      return JSON.stringify({ success: true, triggerId: id });
    },
  };
}

export function createListTriggersTool(store: TriggerStore): ToolDefinition {
  return {
    requiresApproval: false,
    definition: {
      name: "list_triggers",
      description: "List all currently active triggers.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    handler: async () => {
      const triggers = await store.list({ status: "active" });
      return JSON.stringify(triggers, null, 2);
    },
  };
}

// ── SCHEDULE TOOLS ────────────────────────────────────────────────────────────

export function createRegisterScheduleTool(store: ScheduleStore): ToolDefinition {
  return {
    requiresApproval: false,
    definition: {
      name: "register_schedule",
      description: "Register a recurring scheduled LLM run that fires at a cron interval. Use this to set up automated market analysis tasks like premarket scans.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short name for the schedule (e.g. 'Premarket Scan')" },
          description: { type: "string", description: "What this schedule does" },
          cronExpression: { type: "string", description: "5-field cron expression in IST (e.g. '15 9 * * 1-5' for 9:15am Mon-Fri)" },
          tradingDaysOnly: { type: "boolean", description: "If true, skip NSE holidays and weekends" },
          prompt: { type: "string", description: "The instruction for the LLM when this schedule fires (e.g. 'Read latest news, find intraday opportunities, queue promising trades for approval')" },
          strategy_id: { type: "string", description: "Optional strategy ID to link this schedule to a strategy" },
        },
        required: ["name", "description", "cronExpression", "tradingDaysOnly", "prompt"],
      },
    },
    handler: async (args) => {
      const { computeNextRunAt, computeNextTradingRunAt } = await import("./scheduler/service.js");
      const { randomUUID } = await import("crypto");

      const { name, description, cronExpression, tradingDaysOnly, prompt } = args as {
        name: string; description: string; cronExpression: string; tradingDaysOnly: boolean; prompt: string;
      };

      // Validate cron expression
      try {
        parseExpression(cronExpression, { tz: "Asia/Kolkata" });
      } catch (err) {
        return `Error: Invalid cron expression "${cronExpression}": ${err instanceof Error ? err.message : String(err)}`;
      }

      const now = new Date();
      const nextRunAt = tradingDaysOnly
        ? computeNextTradingRunAt(cronExpression, now)
        : computeNextRunAt(cronExpression, now);

      const schedule = {
        id: randomUUID(),
        name,
        description,
        cronExpression,
        tradingDaysOnly,
        prompt,
        status: "active" as const,
        nextRunAt,
        createdAt: now.toISOString(),
        ...(args.strategy_id ? { strategyId: args.strategy_id as string } : {}),
      };

      await store.upsert(schedule);
      return `Schedule "${name}" registered (id: ${schedule.id}). Next run: ${nextRunAt}`;
    },
  };
}

export function createPauseScheduleTool(store: ScheduleStore): ToolDefinition {
  return {
    requiresApproval: false,
    definition: {
      name: "pause_schedule",
      description: "Pause an active schedule so it no longer fires.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Schedule ID to pause" },
        },
        required: ["id"],
      },
    },
    handler: async (args) => {
      const { id } = args as { id: string };
      const schedule = await store.get(id);
      if (!schedule) return `Error: Schedule "${id}" not found`;
      await store.setStatus(id, "paused");
      return `Schedule "${schedule.name}" paused.`;
    },
  };
}

export function createResumeScheduleTool(store: ScheduleStore): ToolDefinition {
  return {
    requiresApproval: false,
    definition: {
      name: "resume_schedule",
      description: "Resume a paused schedule. Recomputes nextRunAt from now.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Schedule ID to resume" },
        },
        required: ["id"],
      },
    },
    handler: async (args) => {
      const { computeNextRunAt, computeNextTradingRunAt } = await import("./scheduler/service.js");
      const { id } = args as { id: string };
      const schedule = await store.get(id);
      if (!schedule) return `Error: Schedule "${id}" not found`;
      const now = new Date();
      const nextRunAt = schedule.tradingDaysOnly
        ? computeNextTradingRunAt(schedule.cronExpression, now)
        : computeNextRunAt(schedule.cronExpression, now);
      await store.setStatus(id, "active");
      await store.updateNextRunAt(id, nextRunAt);
      return `Schedule "${schedule.name}" resumed. Next run: ${nextRunAt}`;
    },
  };
}

export function createListSchedulesTool(store: ScheduleStore): ToolDefinition {
  return {
    requiresApproval: false,
    definition: {
      name: "list_schedules",
      description: "List all active (non-deleted) schedules.",
      input_schema: {
        type: "object",
        properties: {},
      },
    },
    handler: async () => {
      const schedules = await store.list();
      if (schedules.length === 0) return "No schedules found.";
      return JSON.stringify(schedules, null, 2);
    },
  };
}

export function createDeleteScheduleTool(store: ScheduleStore): ToolDefinition {
  return {
    requiresApproval: false,
    definition: {
      name: "delete_schedule",
      description: "Delete a schedule permanently.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Schedule ID to delete" },
        },
        required: ["id"],
      },
    },
    handler: async (args) => {
      const { id } = args as { id: string };
      const schedule = await store.get(id);
      if (!schedule) return `Error: Schedule "${id}" not found`;
      await store.setStatus(id, "deleted");
      return `Schedule "${schedule.name}" deleted.`;
    },
  };
}

// ── STRATEGY TOOLS ────────────────────────────────────────────────────────────

export function createStrategyTools(store: StrategyStore): ToolDefinition[] {
  const createStrategy: ToolDefinition = {
    requiresApproval: false,
    definition: {
      name: "create_strategy",
      description: `Create a named trading strategy with a capital allocation and a written plan.

The plan field should describe the full trading policy: objectives, entry/exit signals, position sizing, and risk rules. After creating a strategy, analyze the plan text and propose concrete triggers and schedules that would implement it. Describe each one, ask the user to confirm, and if confirmed call register_trigger/register_schedule linked to this strategy's id.`,
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short strategy name, e.g. 'Large-Cap Momentum'" },
          description: { type: "string", description: "One-sentence summary of what the strategy does" },
          plan: { type: "string", description: "Full trading plan text: objectives, entry/exit signals, position sizing, risk rules" },
          allocation: { type: "number", description: "Capital envelope in INR, e.g. 500000 for ₹5L" },
        },
        required: ["name", "description", "plan", "allocation"],
      },
    },
    handler: async (args) => {
      const { randomUUID } = await import("crypto");
      const now = new Date().toISOString();
      const strategy = {
        id: randomUUID(),
        name: args.name as string,
        description: args.description as string,
        plan: args.plan as string,
        allocation: args.allocation as number,
        state: "scanning" as const,
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
      };
      await store.upsert(strategy);
      return JSON.stringify({ success: true, strategyId: strategy.id, name: strategy.name });
    },
  };

  const updateStrategyState: ToolDefinition = {
    requiresApproval: false,
    definition: {
      name: "update_strategy_state",
      description: "Update the operational state of a strategy (scanning, accumulating, holding, exiting, paused).",
      input_schema: {
        type: "object",
        properties: {
          strategy_id: { type: "string", description: "Strategy ID" },
          state: { type: "string", enum: ["scanning", "accumulating", "holding", "exiting", "paused"] },
        },
        required: ["strategy_id", "state"],
      },
    },
    handler: async (args) => {
      const { strategy_id, state } = args as { strategy_id: string; state: import("./storage/types.js").StrategyState };
      const strategy = await store.get(strategy_id);
      if (!strategy) return JSON.stringify({ error: `Strategy ${strategy_id} not found` });
      await store.setState(strategy_id, state);
      return JSON.stringify({ success: true, strategyId: strategy_id, state });
    },
  };

  const updateStrategyPlan: ToolDefinition = {
    requiresApproval: false,
    definition: {
      name: "update_strategy_plan",
      description: "Update the trading plan text for a strategy. The next reasoning job will use the updated plan.",
      input_schema: {
        type: "object",
        properties: {
          strategy_id: { type: "string", description: "Strategy ID" },
          plan: { type: "string", description: "New full plan text (replaces existing)" },
        },
        required: ["strategy_id", "plan"],
      },
    },
    handler: async (args) => {
      const { strategy_id, plan } = args as { strategy_id: string; plan: string };
      const strategy = await store.get(strategy_id);
      if (!strategy) return JSON.stringify({ error: `Strategy ${strategy_id} not found` });
      await store.updatePlan(strategy_id, plan);
      return JSON.stringify({ success: true, strategyId: strategy_id });
    },
  };

  const listStrategies: ToolDefinition = {
    requiresApproval: false,
    definition: {
      name: "list_strategies",
      description: "List all active strategies.",
      input_schema: {
        type: "object",
        properties: {},
      },
    },
    handler: async () => {
      const strategies = await store.list({ status: "active" });
      if (strategies.length === 0) return "No active strategies found.";
      return JSON.stringify(strategies, null, 2);
    },
  };

  const archiveStrategy: ToolDefinition = {
    requiresApproval: false,
    definition: {
      name: "archive_strategy",
      description: "Archive a strategy. It will no longer appear in the active list.",
      input_schema: {
        type: "object",
        properties: {
          strategy_id: { type: "string", description: "Strategy ID to archive" },
        },
        required: ["strategy_id"],
      },
    },
    handler: async (args) => {
      const { strategy_id } = args as { strategy_id: string };
      const strategy = await store.get(strategy_id);
      if (!strategy) return JSON.stringify({ error: `Strategy ${strategy_id} not found` });
      await store.setStatus(strategy_id, "archived");
      return JSON.stringify({ success: true, strategyId: strategy_id, status: "archived" });
    },
  };

  return [createStrategy, updateStrategyState, updateStrategyPlan, listStrategies, archiveStrategy];
}

// ── TRADE TOOLS ───────────────────────────────────────────────────────────────

export function createTradeTools(store: TradeStore): ToolDefinition[] {
  const getTradeHistory: ToolDefinition = {
    requiresApproval: false,
    definition: {
      name: "get_trade_history",
      description: "Query the local trade history log. Filter by strategy, symbol, date range, or status. Returns all recorded orders with fill details and P&L.",
      input_schema: {
        type: "object",
        properties: {
          strategy_id: { type: "string", description: "Filter trades belonging to a specific strategy" },
          symbol: { type: "string", description: "Filter by NSE symbol, e.g. 'RELIANCE'" },
          from_date: { type: "string", description: "Start date (YYYY-MM-DD), inclusive" },
          to_date: { type: "string", description: "End date (YYYY-MM-DD), inclusive" },
          status: { type: "string", enum: ["pending", "filled", "cancelled", "rejected"], description: "Filter by trade status" },
        },
        required: [],
      },
    },
    handler: async (args) => {
      const trades = await store.list({
        strategyId: args.strategy_id as string | undefined,
        symbol: args.symbol as string | undefined,
        fromDate: args.from_date as string | undefined,
        toDate: args.to_date as string | undefined,
        status: args.status as import("./storage/types.js").TradeStatus | undefined,
      });
      if (trades.length === 0) return "No trades found matching the given filters.";
      return JSON.stringify(trades, null, 2);
    },
  };

  const syncTradebook: ToolDefinition = {
    requiresApproval: false,
    definition: {
      name: "sync_tradebook",
      description: "Pull today's executed trades from Dhan and update local trade records with fill prices, timestamps, and realized P&L for SELL trades.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    handler: async (_args, client) => {
      const raw = await client.getTradebook();
      const fills = Array.isArray(raw) ? raw : [];

      if (fills.length === 0) return "No trades in today's Dhan tradebook.";

      // Build a map of orderId → fill for fast lookup
      type DhanFill = Record<string, unknown>;
      const fillMap = new Map<string, DhanFill>();
      for (const fill of fills as DhanFill[]) {
        const oid = String(fill["orderId"] ?? fill["order_id"] ?? "");
        if (oid) fillMap.set(oid, fill);
      }

      const allTrades = await store.list();
      let updated = 0;

      for (const trade of allTrades) {
        if (trade.status !== "pending") continue;
        const fill = fillMap.get(trade.orderId);
        if (!fill) continue;

        const executedPrice = (fill["tradedPrice"] as number) ?? (fill["traded_price"] as number);
        const filledAt = String(fill["updateTime"] ?? fill["exchangeTime"] ?? fill["createTime"] ?? new Date().toISOString());
        const patch: Partial<import("./storage/types.js").TradeRecord> = {
          status: "filled",
          executedPrice,
          filledAt,
        };

        // Compute realizedPnl for SELL fills using avg cost of prior BUY fills
        if (trade.transactionType === "SELL" && executedPrice) {
          const priorBuys = (await store.list({ symbol: trade.symbol, status: "filled" }))
            .filter(t => t.transactionType === "BUY" && t.executedPrice && (!trade.strategyId || t.strategyId === trade.strategyId));
          const totalQty = priorBuys.reduce((s, t) => s + t.quantity, 0);
          const totalCost = priorBuys.reduce((s, t) => s + (t.executedPrice! * t.quantity), 0);
          if (totalQty > 0) {
            const avgCost = totalCost / totalQty;
            patch.realizedPnl = +(( executedPrice - avgCost) * trade.quantity).toFixed(2);
          }
        }

        await store.update(trade.id, patch);
        updated++;
      }

      return JSON.stringify({ tradebookEntries: fills.length, localRecordsUpdated: updated });
    },
  };

  const getStrategyPerformance: ToolDefinition = {
    requiresApproval: false,
    definition: {
      name: "get_strategy_performance",
      description: "Get aggregated P&L, win rate, trade count, and open positions for a strategy. Pass no strategy_id to get overall portfolio performance.",
      input_schema: {
        type: "object",
        properties: {
          strategy_id: { type: "string", description: "Strategy ID. Omit for overall portfolio stats." },
        },
        required: [],
      },
    },
    handler: async (args) => {
      const strategyId = args.strategy_id as string | undefined;
      const trades = await store.list({ strategyId, status: "filled" });
      const allTrades = await store.list({ strategyId });

      const buys = trades.filter(t => t.transactionType === "BUY");
      const sells = trades.filter(t => t.transactionType === "SELL");
      const sellsWithPnl = sells.filter(t => t.realizedPnl !== undefined);

      const totalRealizedPnl = +sellsWithPnl.reduce((s, t) => s + t.realizedPnl!, 0).toFixed(2);
      const winningTrades = sellsWithPnl.filter(t => t.realizedPnl! > 0);
      const winRate = sellsWithPnl.length > 0 ? +(winningTrades.length / sellsWithPnl.length).toFixed(2) : null;
      const bestTrade = sellsWithPnl.reduce<import("./storage/types.js").TradeRecord | null>((best, t) => !best || t.realizedPnl! > best.realizedPnl! ? t : best, null);
      const worstTrade = sellsWithPnl.reduce<import("./storage/types.js").TradeRecord | null>((worst, t) => !worst || t.realizedPnl! < worst.realizedPnl! ? t : worst, null);

      // Open positions: net BUY qty - SELL qty per symbol (filled trades only)
      const netQty: Record<string, { quantity: number; totalCost: number }> = {};
      for (const t of trades) {
        if (!netQty[t.symbol]) netQty[t.symbol] = { quantity: 0, totalCost: 0 };
        if (t.transactionType === "BUY") {
          netQty[t.symbol].quantity += t.quantity;
          netQty[t.symbol].totalCost += (t.executedPrice ?? 0) * t.quantity;
        } else {
          netQty[t.symbol].quantity -= t.quantity;
        }
      }
      const openPositions = Object.entries(netQty)
        .filter(([, v]) => v.quantity > 0)
        .map(([symbol, v]) => ({
          symbol,
          quantity: v.quantity,
          avgBuyPrice: v.quantity > 0 ? +(v.totalCost / v.quantity).toFixed(2) : 0,
        }));

      return JSON.stringify({
        strategyId: strategyId ?? "all",
        totalTrades: allTrades.length,
        filledTrades: trades.length,
        pendingTrades: allTrades.filter(t => t.status === "pending").length,
        buyTrades: buys.length,
        sellTrades: sells.length,
        totalRealizedPnl,
        winRate,
        bestTrade: bestTrade ? { symbol: bestTrade.symbol, pnl: bestTrade.realizedPnl, date: bestTrade.filledAt } : null,
        worstTrade: worstTrade ? { symbol: worstTrade.symbol, pnl: worstTrade.realizedPnl, date: worstTrade.filledAt } : null,
        openPositions,
      }, null, 2);
    },
  };

  return [getTradeHistory, syncTradebook, getStrategyPerformance];
}
