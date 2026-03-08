import type Anthropic from "@anthropic-ai/sdk";
import { DhanClient } from "./dhan/client.js";
import type { MemoryStore, TriggerStore } from "./storage/index.js";
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
        const nseEq = (result as Record<string, unknown>)["NSE_EQ"];
        if (Array.isArray(nseEq)) allData.push(...nseEq);
      }

      type QuoteItem = {
        tradingSymbol: string;
        lastPrice: number;
        previousClose: number;
        pct_change: number;
      };

      const items: QuoteItem[] = (allData as Array<Record<string, unknown>>)
        .filter((q) => q["lastPrice"] && q["previousClose"])
        .map((q) => ({
          tradingSymbol: q["tradingSymbol"] as string,
          lastPrice: q["lastPrice"] as number,
          previousClose: q["previousClose"] as number,
          pct_change: +(((q["lastPrice"] as number) - (q["previousClose"] as number)) / (q["previousClose"] as number) * 100).toFixed(2),
        }));

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
        const items = (result as Record<string, unknown>)[segKey];
        if (Array.isArray(items)) {
          for (const q of items as Array<Record<string, unknown>>) {
            const id = String(q["securityId"] ?? q["security_id"] ?? "");
            const sym = (q["tradingSymbol"] as string ?? "").toUpperCase();
            if (id) quoteMap[id] = q;
            if (sym) quoteMap[sym] = q;
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
              mode: { type: "string", enum: ["code", "llm"] },
              expression: { type: "string", description: "JS expression (code mode)" },
              description: { type: "string", description: "Natural language condition (llm mode)" },
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
