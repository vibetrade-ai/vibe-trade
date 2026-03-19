import type Anthropic from "@anthropic-ai/sdk";
import { parseExpression } from "cron-parser";
import type { BrokerAdapter, BrokerCapabilities, CandleInterval } from "./brokers/types.js";
import type { MemoryStore, TriggerStore, TriggerAuditStore, StrategyStore, TradeStore, PortfolioStore } from "./storage/index.js";
import type { TradeArgs } from "./heartbeat/types.js";
import {
  searchInstruments,
  isEtf,
} from "./brokers/dhan/instruments.js";
import {
  getIndexConstituents,
  getIndexConstituentInfo,
} from "./market-data/nse.js";
import { computeIndicators } from "./indicators.js";
import { getFundamentals, getEtfInfo } from "./yahoo.js";
import { fetchNews } from "./news.js";
import { getMarketStatus, isTradingDay, getUpcomingHolidays } from "./market-calendar.js";
import { syncOrders } from "./brokers/dhan/order-sync.js";
import { computeOpenPositions } from "./trade-utils.js";

export interface ToolDefinition {
  definition: Anthropic.Tool;
  requiresApproval: boolean;
  requiresCapability?: keyof BrokerCapabilities;
  handler: (args: Record<string, unknown>, broker: BrokerAdapter) => Promise<string>;
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
    handler: async (args, broker) => {
      const symbols = args.symbols as string[];
      const quotes = await broker.getQuote(symbols);
      return JSON.stringify(quotes, null, 2);
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
    handler: async (args, broker) => {
      const quotes = await broker.getQuote([args.index as string]);
      return JSON.stringify(quotes, null, 2);
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
    handler: async (args, _broker) => {
      const constituents = await getIndexConstituentInfo(args.index as string);
      return JSON.stringify({ index: (args.index as string).toUpperCase(), count: constituents.length, constituents }, null, 2);
    },
  },

  get_positions: {
    requiresApproval: false,
    definition: {
      name: "get_positions",
      description: "Get all open positions in the brokerage account.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    handler: async (_args, broker) => {
      const positions = await broker.getPositions();
      return JSON.stringify(positions, null, 2);
    },
  },

  get_funds: {
    requiresApproval: false,
    definition: {
      name: "get_funds",
      description: "Get available balance, used margin, and day P&L for the brokerage account.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    handler: async (_args, broker) => {
      const funds = await broker.getFunds();
      return JSON.stringify(funds, null, 2);
    },
  },

  get_orders: {
    requiresApproval: false,
    definition: {
      name: "get_orders",
      description: "Get today's full order book from the brokerage account.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    handler: async (_args, broker) => {
      const orders = await broker.getOrders();
      return JSON.stringify(orders, null, 2);
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
    handler: async (args, broker) => {
      const symbol = (args.symbol as string).toUpperCase();
      const placeResult = await broker.placeOrder({
        symbol,
        side: args.transaction_type as "BUY" | "SELL",
        quantity: args.quantity as number,
        orderType: args.order_type as "MARKET" | "LIMIT",
        productType: "INTRADAY",
        price: args.price as number | undefined,
      });
      const orderId = placeResult.orderId;
      if (!orderId) return JSON.stringify(placeResult);

      try {
        await new Promise(r => setTimeout(r, 1500));
        const order = await broker.getOrderById(orderId);
        const message =
          order.status === "FILLED" ? `Order filled at ₹${order.price}`
          : order.status === "REJECTED" ? `Order REJECTED: ${order.statusMessage}`
          : `Order accepted, awaiting confirmation (status: ${order.status})`;
        return JSON.stringify({
          orderId,
          currentStatus: order.status,
          executedPrice: order.price ?? null,
          rejectionReason: order.statusMessage ?? null,
          filledAt: order.updatedAt.toISOString(),
          message,
        }, null, 2);
      } catch {
        return JSON.stringify(placeResult, null, 2);
      }
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
            description: "The order ID to cancel",
          },
        },
        required: ["order_id"],
      },
    },
    handler: async (args, broker) => {
      await broker.cancelOrder(args.order_id as string);
      return JSON.stringify({ success: true, orderId: args.order_id });
    },
  },

  // ── NEW MARKET DATA TOOLS ─────────────────────────────────────────────────

  get_historical_data: {
    requiresApproval: false,
    requiresCapability: "supportsHistoricalData",
    definition: {
      name: "get_historical_data",
      description:
        "Get historical OHLCV candles for an NSE equity, ETF, or index symbol (e.g. NIFTY50, BANKNIFTY, NIFTYBEES). Supports intraday (1m/5m/15m/1h) and daily intervals.",
      input_schema: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "NSE trading symbol or index name, e.g. 'RELIANCE', 'NIFTY50', 'BANKNIFTY'",
          },
          interval: {
            type: "string",
            enum: ["1m", "5m", "15m", "25m", "1h", "1d"],
            description: "Candle interval. '1m','5m','15m','25m','1h' for intraday; '1d' for daily.",
          },
          days: {
            type: "number",
            description: "Number of past days of data to fetch (max 365 for daily, 30 for intraday).",
          },
        },
        required: ["symbol", "interval", "days"],
      },
    },
    handler: async (args, broker) => {
      const symbol = args.symbol as string;
      const interval = args.interval as CandleInterval;
      const days = Math.min(args.days as number, interval === "1d" ? 365 : 30);
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - days);
      const candles = await broker.getHistory(symbol, interval, from, to);
      return JSON.stringify(candles.slice(-200), null, 2);
    },
  },

  compute_indicators: {
    requiresApproval: false,
    requiresCapability: "supportsHistoricalData",
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
            enum: ["1m", "5m", "15m", "25m", "1h", "1d"],
            description: "Candle interval. '1m','5m','15m','25m','1h' for intraday; '1d' for daily.",
          },
          days: {
            type: "number",
            description: "Number of past days of data to base calculations on.",
          },
        },
        required: ["symbol", "interval", "days"],
      },
    },
    handler: async (args, broker) => {
      const symbol = args.symbol as string;
      const interval = args.interval as CandleInterval;
      const days = Math.min(args.days as number, interval === "1d" ? 365 : 30);
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - days);
      const candles = await broker.getHistory(symbol, interval, from, to);
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
    handler: async (args, _broker) => {
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
    handler: async (args, _broker) => {
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
    handler: async (args, _broker) => {
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
    handler: async (_args, _broker) => {
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
    handler: async (args, _broker) => {
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
    handler: async (args, _broker) => {
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
    handler: async (args, _broker) => {
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
    requiresCapability: "availableIndices",
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
    handler: async (args, broker) => {
      const n = Math.min(Math.max((args.n as number) ?? 5, 1), 25);
      const index = (args.index as string) ?? "NIFTY50";
      const symbols = await getIndexConstituents(index);
      if (symbols.length === 0) return JSON.stringify({ error: `No constituents found for index: ${index}` });

      const quotes = await broker.getQuote(symbols);
      const items = quotes
        .filter(q => q.lastPrice > 0)
        .map(q => ({ tradingSymbol: q.symbol, lastPrice: q.lastPrice, previousClose: q.previousClose, pct_change: q.changePercent }));
      items.sort((a, b) => b.pct_change - a.pct_change);
      const gainers = items.slice(0, n);
      const losers = items.slice(-n).reverse();
      return JSON.stringify({ index, gainers, losers }, null, 2);
    },
  },

  get_market_depth: {
    requiresApproval: false,
    requiresCapability: "supportsMarketDepth",
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
    handler: async (args, broker) => {
      const depth = await broker.getMarketDepth(args.symbol as string);
      return JSON.stringify(depth, null, 2);
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
    handler: async (args, broker) => {
      const symbols = args.symbols as string[];
      if (symbols.length < 2 || symbols.length > 5) {
        return JSON.stringify({ error: "Provide 2–5 symbols for comparison." });
      }

      const quotes = await broker.getQuote(symbols);
      const quoteMap = new Map(quotes.map(q => [q.symbol.toUpperCase(), q]));
      const availableIndices = new Set(broker.capabilities.availableIndices.map(i => i.toUpperCase()));

      const fundamentalsArr = await Promise.all(
        symbols.map(s =>
          !availableIndices.has(s.toUpperCase())
            ? getFundamentals(s).catch(() => ({ symbol: s }))
            : Promise.resolve(null)
        )
      );

      const comparison = symbols.map((sym, i) => {
        const quote = quoteMap.get(sym.toUpperCase());
        const fund = fundamentalsArr[i] as Record<string, unknown> | null;
        return {
          symbol: sym.toUpperCase(),
          type: availableIndices.has(sym.toUpperCase()) ? "INDEX" : "EQUITY",
          last_price: quote?.lastPrice,
          change_pct: quote?.changePercent,
          ...(fund ? {
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
          } : {}),
        };
      });

      return JSON.stringify(comparison, null, 2);
    },
  },
};

export function getAllToolDefinitions(extra: ToolDefinition[] = [], broker?: BrokerAdapter): Anthropic.Tool[] {
  const tools = [...Object.values(TOOLS), ...extra];
  // Filter by capabilities if broker is provided
  if (broker) {
    return tools
      .filter(t => {
        if (!t.requiresCapability) return true;
        const cap = t.requiresCapability as string;
        const val = broker.capabilities[cap as keyof BrokerCapabilities];
        if (typeof val === "boolean") return val;
        if (Array.isArray(val)) return val.length > 0;
        return true;
      })
      .map(t => t.definition);
  }
  return tools.map(t => t.definition);
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

Condition modes:
- "code": A JavaScript expression evaluated against the snapshot. Variables: quotes["SYMBOL"].lastPrice/changePercent/open/high/low, positions (array), funds.availableBalance, nifty50.lastPrice/changePercent, banknifty.lastPrice/changePercent. When event triggers are also active, the sandbox also exposes: events.newPositions, events.closedPositions, events.newHeadlines (Record<category, NewsItem[]>), fundamentals (Record<symbol, Fundamentals|null>), vix.lastPrice. Expression must return exactly true to fire.
- "llm": Natural language condition evaluated by AI each tick. Use for qualitative/nuanced conditions.
- "time": Fire at a specific time.
  • One-shot: use the "at" field with an ISO timestamp — fires once when Date.now() >= at
  • Recurring: use the "cron" field with a 5-field cron expression in IST (e.g. "15 9 * * 1-5" for 9:15am Mon-Fri). Combines with tradingDaysOnly to skip NSE holidays.
- "event": Typed, structured event condition. Pick a kind and fill in its parameters:
  • kind "position_opened"     — fires when any of symbols[] enters the portfolio. params: symbols[]
  • kind "position_closed"     — fires when any of symbols[] leaves the portfolio. params: symbols[]
  • kind "news_mention"        — fires when any symbol in symbols[] appears in new headlines for categories[]. params: symbols[], categories[] (e.g. ["markets","companies"])
  • kind "sentiment_positive"  — fires when Haiku judges new headlines for categories[] as positive for any symbol in symbols[]. params: symbols[], categories[]
  • kind "sentiment_negative"  — fires when Haiku judges new headlines for categories[] as negative for any symbol in symbols[]. params: symbols[], categories[]
  • kind "pe_below"            — fires when cached PE for symbol drops below threshold. params: symbol, threshold
  • kind "pe_above"            — fires when cached PE for symbol rises above threshold (expensive, consider exit). params: symbol, threshold
  • kind "fundamentals_changed"— fires when fresh fundamentals data arrives for symbol. params: symbol
  • kind "vix_above"           — fires when India VIX spot price exceeds threshold. params: threshold
  • kind "vix_below"           — fires when India VIX spot price drops below threshold (volatility calm, deploy capital). params: threshold
  • kind "nifty_drop_percent"  — fires when Nifty50 intraday drop exceeds threshold (e.g. threshold: 1.5 means -1.5%). params: threshold
  • kind "nifty_rise_percent"  — fires when Nifty50 intraday rally exceeds threshold (e.g. threshold: 1.5 means +1.5%). params: threshold

Two action types:
- "reasoning_job": Fires an autonomous Sonnet analysis loop that can queue trade proposals. Always include prompt.
- "hard_order": Executes a trade immediately when condition fires. REQUIRES user approval — you will receive a prompt.

watchSymbols: List every symbol referenced in the condition so the snapshot builder fetches them. Use [] for market/time conditions.

Examples:
- condition: { mode: "code", expression: "quotes['RELIANCE'].lastPrice < 2800" }
- condition: { mode: "time", cron: "15 9 * * 1-5" }, tradingDaysOnly: true  ← recurring 9:15am
- condition: { mode: "time", at: "2026-03-20T09:15:00.000Z" }  ← one-shot
- condition: { mode: "event", kind: "position_opened", symbols: ["*"] }
- condition: { mode: "event", kind: "vix_above", threshold: 18 }`,
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Human-readable trigger name" },
          scope: { type: "string", enum: ["symbol", "market", "portfolio"] },
          watchSymbols: {
            type: "array",
            items: { type: "string" },
            description: "All NSE symbols referenced in the condition (for snapshot fetching). Use [] for market/portfolio/time conditions.",
          },
          condition: {
            type: "object",
            description: "Trigger condition",
            properties: {
              mode: { type: "string", enum: ["code", "llm", "time", "event"] },
              expression: { type: "string", description: "JS expression (code mode)" },
              description: { type: "string", description: "Natural language condition (llm mode)" },
              at: { type: "string", description: "ISO timestamp for one-shot time triggers" },
              cron: { type: "string", description: "5-field cron expression in IST for recurring time triggers (e.g. '15 9 * * 1-5')" },
              kind: { type: "string", enum: ["position_opened", "position_closed", "news_mention", "sentiment_positive", "sentiment_negative", "pe_below", "pe_above", "fundamentals_changed", "vix_above", "vix_below", "nifty_drop_percent", "nifty_rise_percent"], description: "Event kind (event mode only)" },
              symbols: { type: "array", items: { type: "string" }, description: "Symbols to watch (position/news/sentiment event kinds). Use [\"*\"] to match any symbol." },
              categories: { type: "array", items: { type: "string" }, description: "RSS categories to watch: markets, companies, economy, finance (news/sentiment event kinds)" },
              symbol: { type: "string", description: "Single symbol for pe_below / fundamentals_changed event kinds" },
              threshold: { type: "number", description: "Numeric threshold for pe_below, vix_above, nifty_drop_percent event kinds" },
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
          prompt: { type: "string", description: "What the autonomous reasoning job should do when this trigger fires. Required for reasoning_job action types. Be specific about the analysis and decision criteria." },
          expiresAt: { type: "string", description: "ISO date string — trigger auto-expires if condition never fires by this time (not applicable to cron triggers)" },
          tradingDaysOnly: { type: "boolean", description: "If true, skip NSE holidays and weekends. Primarily for cron triggers." },
          staleAfterMs: { type: "number", description: "For cron/time triggers: how many ms after the scheduled time the job is considered stale and should be skipped. Max 7200000 (2 hours)." },
          recurring: { type: "boolean", description: "For code/llm/event triggers: if true, re-arms after firing (combined with cooldownMs to prevent spam)" },
          cooldownMs: { type: "number", description: "For recurring code/llm/event triggers: minimum ms between firings" },
          strategy_id: { type: "string", description: "Optional strategy ID to link this trigger to a strategy (soft reference for backward compat)" },
          portfolio_id: { type: "string", description: "Optional portfolio ID to attribute trades and enforce capital limits from this trigger" },
          context: { type: "string", description: "Optional inline context/goal for the reasoning job (in addition to prompt). Useful for adding strategy-specific hints." },
        },
        required: ["name", "scope", "watchSymbols", "condition", "action"],
      },
    },
    handler: async (args) => {
      // Hard-order triggers are intercepted in chat.ts before this handler runs
      const { randomUUID } = await import("crypto");
      const conditionArgs = args.condition as Record<string, unknown>;

      // Validate and compute nextFireAt for cron triggers
      let nextFireAt: string | undefined;
      if (conditionArgs.mode === "time" && conditionArgs.cron) {
        try {
          parseExpression(conditionArgs.cron as string, { tz: "Asia/Kolkata" });
        } catch (err) {
          return `Error: Invalid cron expression "${conditionArgs.cron}": ${err instanceof Error ? err.message : String(err)}`;
        }
        const { computeNextRunAt, computeNextTradingRunAt } = await import("./heartbeat/cron-utils.js");
        const tradingDaysOnly = args.tradingDaysOnly as boolean | undefined ?? false;
        const now = new Date();
        nextFireAt = tradingDaysOnly
          ? computeNextTradingRunAt(conditionArgs.cron as string, now)
          : computeNextRunAt(conditionArgs.cron as string, now);
      }

      const MAX_STALE_MS = 2 * 60 * 60 * 1000;
      const staleAfterMs = args.staleAfterMs != null
        ? Math.min(args.staleAfterMs as number, MAX_STALE_MS)
        : undefined;

      const actionArgs = args.action as Record<string, unknown>;
      const action = {
        type: actionArgs.type as string,
        ...(actionArgs.type === "hard_order" ? { tradeArgs: actionArgs.tradeArgs as TradeArgs } : {}),
        ...(args.prompt ? { prompt: args.prompt as string } : {}),
      };

      const trigger = {
        id: randomUUID(),
        name: args.name as string,
        scope: args.scope as "symbol" | "market" | "portfolio",
        watchSymbols: args.watchSymbols as string[],
        condition: args.condition as { mode: "code"; expression: string } | { mode: "llm"; description: string },
        action: action as { type: "reasoning_job"; prompt?: string } | { type: "hard_order"; tradeArgs: TradeArgs },
        expiresAt: args.expiresAt as string | undefined,
        createdAt: new Date().toISOString(),
        active: true,
        status: "active" as const,
        ...(args.strategy_id ? { strategyId: args.strategy_id as string } : {}),
        ...(args.portfolio_id ? { portfolioId: args.portfolio_id as string } : {}),
        ...(args.context ? { context: args.context as string } : {}),
        ...(args.tradingDaysOnly != null ? { tradingDaysOnly: args.tradingDaysOnly as boolean } : {}),
        ...(staleAfterMs != null ? { staleAfterMs } : {}),
        ...(args.recurring != null ? { recurring: args.recurring as boolean } : {}),
        ...(args.cooldownMs != null ? { cooldownMs: args.cooldownMs as number } : {}),
        ...(nextFireAt ? { nextFireAt } : {}),
      };
      await store.upsert(trigger);
      return JSON.stringify({
        success: true,
        triggerId: trigger.id,
        name: trigger.name,
        ...(nextFireAt ? { nextFireAt } : {}),
      });
    },
  };
}

export function createPauseTriggerTool(store: TriggerStore): ToolDefinition {
  return {
    requiresApproval: false,
    definition: {
      name: "pause_trigger",
      description: "Pause an active trigger (especially cron triggers) so it no longer fires. The trigger can be resumed later.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Trigger ID to pause" },
        },
        required: ["id"],
      },
    },
    handler: async (args) => {
      const { id } = args as { id: string };
      const trigger = await store.get(id);
      if (!trigger) return `Error: Trigger "${id}" not found`;
      if (trigger.status !== "active") return `Error: Trigger "${id}" is not active (status: ${trigger.status})`;
      await store.setStatus(id, "paused");
      return `Trigger "${trigger.name}" paused.`;
    },
  };
}

export function createResumeTriggerTool(store: TriggerStore): ToolDefinition {
  return {
    requiresApproval: false,
    definition: {
      name: "resume_trigger",
      description: "Resume a paused trigger. For cron triggers, recomputes nextFireAt from now.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Trigger ID to resume" },
        },
        required: ["id"],
      },
    },
    handler: async (args) => {
      const { id } = args as { id: string };
      const trigger = await store.get(id);
      if (!trigger) return `Error: Trigger "${id}" not found`;
      if (trigger.status !== "paused") return `Error: Trigger "${id}" is not paused (status: ${trigger.status})`;
      const cond = trigger.condition as { mode: string; cron?: string };
      if (cond.cron) {
        const { computeNextRunAt, computeNextTradingRunAt } = await import("./heartbeat/cron-utils.js");
        const now = new Date();
        const nextFireAt = trigger.tradingDaysOnly
          ? computeNextTradingRunAt(cond.cron, now)
          : computeNextRunAt(cond.cron, now);
        await store.updateNextFireAt(id, nextFireAt, undefined);
        await store.setStatus(id, "active");
        return `Trigger "${trigger.name}" resumed. Next fire: ${nextFireAt}`;
      }
      await store.setStatus(id, "active");
      return `Trigger "${trigger.name}" resumed.`;
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
      description: "List all active and paused triggers.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    handler: async () => {
      const triggers = await store.list({ status: ["active", "paused"] });
      return JSON.stringify(triggers, null, 2);
    },
  };
}

export function createGetTriggerRunsTool(store: TriggerAuditStore): ToolDefinition {
  return {
    requiresApproval: false,
    definition: {
      name: "get_trigger_runs",
      description: "Get recent run history for triggers. Use this when the user asks what happened when a trigger fired, whether it ran, or what trades it queued.",
      input_schema: {
        type: "object",
        properties: {
          trigger_name: { type: "string", description: "Filter by trigger name (case-insensitive substring match). Omit to return runs across all triggers." },
          trigger_id: { type: "string", description: "Filter by exact trigger ID." },
          limit: { type: "number", description: "Number of runs to return (default 5, max 20)" },
        },
      },
    },
    handler: async (args) => {
      const { trigger_name, trigger_id, limit } = args as { trigger_name?: string; trigger_id?: string; limit?: number };
      const cap = Math.min(limit ?? 5, 20);
      let entries = await store.list();

      if (trigger_id) {
        entries = entries.filter(e => e.triggerId === trigger_id);
      } else if (trigger_name) {
        const needle = trigger_name.toLowerCase();
        entries = entries.filter(e => e.triggerName?.toLowerCase().includes(needle));
      }

      entries = entries.slice(0, cap);

      if (entries.length === 0) {
        return trigger_name || trigger_id
          ? `No runs found for the specified trigger.`
          : "No trigger runs recorded yet.";
      }

      return entries.map(e => {
        const firedAt = new Date(e.firedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
        let outcomeStr: string;
        switch (e.outcome.type) {
          case "hard_order_placed":
            outcomeStr = `hard order placed (orderId: ${e.outcome.orderId})`;
            break;
          case "hard_order_failed":
            outcomeStr = `hard order failed: ${e.outcome.error}`;
            break;
          case "reasoning_job_queued":
            outcomeStr = e.outcome.approvalId
              ? `reasoning job — queued approval ${e.outcome.approvalId}`
              : "reasoning job — no approval queued";
            break;
          case "reasoning_job_completed":
            outcomeStr = `reasoning job completed — ${e.outcome.summary}${e.outcome.approvalIds.length > 0 ? ` (${e.outcome.approvalIds.length} approval(s))` : ""}, took ${Math.round(e.outcome.durationMs / 1000)}s`;
            break;
          case "reasoning_job_no_action":
            outcomeStr = `no action — ${e.outcome.reason}`;
            break;
          default:
            outcomeStr = "unknown outcome";
        }
        return `Trigger: "${e.triggerName}"  (${firedAt} IST)\nOutcome: ${outcomeStr}`;
      }).join("\n\n");
    },
  };
}

// ── STRATEGY TOOLS ────────────────────────────────────────────────────────────

export function createStrategyTools(
  store: StrategyStore,
  triggerStore?: TriggerStore,
  tradeStore?: TradeStore,
): ToolDefinition[] {
  const createStrategy: ToolDefinition = {
    requiresApproval: false,
    definition: {
      name: "create_strategy",
      description: `Create a named trading strategy document with a written plan.

The plan field should describe the full trading policy: objectives, entry/exit signals, position sizing, and risk rules. After creating a strategy, analyze the plan text and propose concrete triggers that would implement it (use register_trigger with cron condition for recurring analysis). Describe each one, ask the user to confirm, and if confirmed call register_trigger linked to this strategy's id.

Note: strategies are pure documents — capital allocation belongs on a Portfolio. If the user wants to allocate capital, create a portfolio and attach this strategy to it.`,
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short strategy name, e.g. 'Large-Cap Momentum'" },
          description: { type: "string", description: "One-sentence summary of what the strategy does" },
          plan: { type: "string", description: "Full trading plan text: objectives, entry/exit signals, position sizing, risk rules" },
        },
        required: ["name", "description", "plan"],
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

      // Guard: block archive if strategy has open positions
      if (tradeStore) {
        const filled = await tradeStore.list({ strategyId: strategy_id, status: "filled" });
        const openPositions = computeOpenPositions(filled);
        if (openPositions.length > 0) {
          return JSON.stringify({
            error: "Strategy has open positions",
            openPositions: openPositions.map(p => ({ symbol: p.symbol, quantity: p.quantity })),
            hint: "Close all tagged positions in the broker before archiving",
          });
        }
      }

      // Cascade: cancel active and paused triggers
      let triggersCancelled = 0;
      if (triggerStore) {
        const linkedTriggers = await triggerStore.list({ status: ["active", "paused"] });
        const linked = linkedTriggers.filter(t => t.strategyId === strategy_id);
        await Promise.all(linked.map(t => triggerStore.setStatus(t.id, "cancelled")));
        triggersCancelled = linked.length;
      }

      await store.setStatus(strategy_id, "archived");
      return JSON.stringify({ success: true, strategyId: strategy_id, status: "archived", triggersCancelled });
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
      description: "Pull today's executed trades from the broker and update local trade records with fill prices, timestamps, and realized P&L for SELL trades.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    handler: async (_args, broker) => {
      const result = await syncOrders(broker, store);
      return JSON.stringify({
        fillsUpdated: result.fillsUpdated,
        rejectedOrCancelledDetected: result.rejectedOrCancelled,
      });
    },
  };

  return [getTradeHistory, syncTradebook];
}

// ── PORTFOLIO TOOLS ───────────────────────────────────────────────────────────

export function createPortfolioTools(
  portfolioStore: PortfolioStore,
  triggerStore?: TriggerStore,
  tradeStore?: TradeStore,
): ToolDefinition[] {
  const createPortfolio: ToolDefinition = {
    requiresApproval: false,
    definition: {
      name: "create_portfolio",
      description: "Create a portfolio with a capital allocation. Portfolios enforce capital limits in code — trades attributed to a portfolio will be rejected if they would exceed the allocation. Attach strategy documents to a portfolio to provide context to its reasoning jobs.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Portfolio name, e.g. 'Auto Basket'" },
          description: { type: "string", description: "What this portfolio is for" },
          allocation: { type: "number", description: "Capital envelope in INR, e.g. 1000000 for ₹10L" },
          benchmark: { type: "string", description: "Optional index symbol for comparison, e.g. 'NIFTYAUTO'" },
        },
        required: ["name", "description", "allocation"],
      },
    },
    handler: async (args) => {
      const { randomUUID } = await import("crypto");
      const now = new Date().toISOString();
      const portfolio = {
        id: randomUUID(),
        name: args.name as string,
        description: args.description as string,
        allocation: args.allocation as number,
        benchmark: args.benchmark as string | undefined,
        strategyIds: [] as string[],
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
      };
      await portfolioStore.upsert(portfolio);
      return JSON.stringify({ success: true, portfolioId: portfolio.id, name: portfolio.name });
    },
  };

  const listPortfolios: ToolDefinition = {
    requiresApproval: false,
    definition: {
      name: "list_portfolios",
      description: "List all active portfolios.",
      input_schema: { type: "object", properties: {} },
    },
    handler: async () => {
      const portfolios = await portfolioStore.list({ status: "active" });
      if (portfolios.length === 0) return "No active portfolios found.";
      return JSON.stringify(portfolios, null, 2);
    },
  };

  const getPortfolioPerformance: ToolDefinition = {
    requiresApproval: false,
    definition: {
      name: "get_portfolio_performance",
      description: "Get aggregated P&L, win rate, deployed capital, and open positions for a portfolio.",
      input_schema: {
        type: "object",
        properties: {
          portfolio_id: { type: "string", description: "Portfolio ID" },
        },
        required: ["portfolio_id"],
      },
    },
    handler: async (args) => {
      if (!tradeStore) return JSON.stringify({ error: "Trade store not available" });
      const portfolioId = args.portfolio_id as string;
      const portfolio = await portfolioStore.get(portfolioId);
      if (!portfolio) return JSON.stringify({ error: `Portfolio ${portfolioId} not found` });

      const { computeOpenPositions } = await import("./trade-utils.js");
      const allTrades = await tradeStore.list({ portfolioId });
      const filled = allTrades.filter(t => t.status === "filled");
      const sells = filled.filter(t => t.transactionType === "SELL");
      const sellsWithPnl = sells.filter(t => t.realizedPnl !== undefined);

      const totalRealizedPnl = +sellsWithPnl.reduce((s, t) => s + t.realizedPnl!, 0).toFixed(2);
      const winRate = sellsWithPnl.length > 0
        ? +(sellsWithPnl.filter(t => t.realizedPnl! > 0).length / sellsWithPnl.length).toFixed(2)
        : null;
      const openPositions = computeOpenPositions(filled);
      const deployedCapital = openPositions.reduce((s, p) => s + p.deployedCapital, 0);

      return JSON.stringify({
        portfolioId,
        portfolioName: portfolio.name,
        allocation: portfolio.allocation,
        deployedCapital: +deployedCapital.toFixed(2),
        availableCapital: +(portfolio.allocation - deployedCapital).toFixed(2),
        totalTrades: allTrades.length,
        filledTrades: filled.length,
        totalRealizedPnl,
        winRate,
        openPositions,
      }, null, 2);
    },
  };

  const attachStrategyToPortfolio: ToolDefinition = {
    requiresApproval: false,
    definition: {
      name: "attach_strategy_to_portfolio",
      description: "Attach a strategy document to a portfolio. The strategy's plan text will be injected as context in the portfolio's reasoning jobs.",
      input_schema: {
        type: "object",
        properties: {
          portfolio_id: { type: "string", description: "Portfolio ID" },
          strategy_id: { type: "string", description: "Strategy ID to attach" },
        },
        required: ["portfolio_id", "strategy_id"],
      },
    },
    handler: async (args) => {
      const { portfolio_id, strategy_id } = args as { portfolio_id: string; strategy_id: string };
      const portfolio = await portfolioStore.get(portfolio_id);
      if (!portfolio) return JSON.stringify({ error: `Portfolio ${portfolio_id} not found` });
      await portfolioStore.addStrategy(portfolio_id, strategy_id);
      return JSON.stringify({ success: true, portfolioId: portfolio_id, strategyId: strategy_id });
    },
  };

  const archivePortfolio: ToolDefinition = {
    requiresApproval: false,
    definition: {
      name: "archive_portfolio",
      description: "Archive a portfolio. Warns if open positions exist. Pauses all linked triggers.",
      input_schema: {
        type: "object",
        properties: {
          portfolio_id: { type: "string", description: "Portfolio ID to archive" },
        },
        required: ["portfolio_id"],
      },
    },
    handler: async (args) => {
      const { portfolio_id } = args as { portfolio_id: string };
      const portfolio = await portfolioStore.get(portfolio_id);
      if (!portfolio) return JSON.stringify({ error: `Portfolio ${portfolio_id} not found` });

      // Guard: warn if open positions
      if (tradeStore) {
        const { computeOpenPositions } = await import("./trade-utils.js");
        const filled = await tradeStore.list({ portfolioId: portfolio_id, status: "filled" });
        const openPositions = computeOpenPositions(filled);
        if (openPositions.length > 0) {
          return JSON.stringify({
            error: "Portfolio has open positions",
            openPositions: openPositions.map(p => ({ symbol: p.symbol, quantity: p.quantity })),
            hint: "Close all attributed positions in the broker before archiving",
          });
        }
      }

      // Cascade: pause linked triggers
      let triggersPaused = 0;
      if (triggerStore) {
        const linked = await triggerStore.list({ status: ["active"] });
        const portfolioTriggers = linked.filter(t => t.portfolioId === portfolio_id);
        await Promise.all(portfolioTriggers.map(t => triggerStore.setStatus(t.id, "paused")));
        triggersPaused = portfolioTriggers.length;
      }

      await portfolioStore.setStatus(portfolio_id, "archived");
      return JSON.stringify({ success: true, portfolioId: portfolio_id, status: "archived", triggersPaused });
    },
  };

  return [createPortfolio, listPortfolios, getPortfolioPerformance, attachStrategyToPortfolio, archivePortfolio];
}
