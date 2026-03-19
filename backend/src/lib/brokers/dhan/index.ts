import { DhanClient } from "./client.js";
import { getSecurityId, getIndexSecurityId, searchInstruments as dhanSearch } from "./instruments.js";
import { parseDhanCandles } from "./candles.js";
import type {
  BrokerAdapter, BrokerCapabilities, Quote, Candle, OrderBook, Position, Funds,
  Order, OrderParams, OrderResult, Trade, Instrument, CandleInterval, AssetClass, OrderStatus
} from "../types.js";

export const DHAN_CAPABILITIES: BrokerCapabilities = {
  name: "Dhan",
  markets: ["NSE", "BSE"],
  assetClasses: ["EQUITY", "ETF", "INDEX", "FUTURES", "OPTIONS"],
  supportsHistoricalData: true,
  supportsMarketDepth: true,
  supportsStreaming: false,
  supportsFractionalQuantity: false,
  availableIndices: [
    "NIFTY50", "BANKNIFTY", "FINNIFTY", "NIFTY100", "NIFTY500",
    "NIFTYNEXT50", "NIFTYSMALLCAP100", "NIFTYMIDCAP100",
    "NIFTYIT", "NIFTYAUTO", "NIFTYPHARMA", "NIFTYFMCG",
    "NIFTYBANK", "NIFTYFINANCE",
  ],
};

// @internal — exported for unit testing only
export function toDhanInterval(interval: CandleInterval): "1" | "5" | "15" | "25" | "60" | "D" {
  const map: Record<CandleInterval, "1" | "5" | "15" | "25" | "60" | "D"> = {
    "1m": "1", "5m": "5", "15m": "15", "25m": "25", "1h": "60", "1d": "D",
  };
  return map[interval];
}

// @internal — exported for unit testing only
export function parseDhanOrderStatus(dhanStatus: string): OrderStatus {
  const s = dhanStatus.toUpperCase();
  if (s === "TRADED") return "FILLED";
  if (s === "PART_TRADED") return "PARTIALLY_FILLED";
  if (s === "REJECTED") return "REJECTED";
  if (s === "CANCELLED" || s === "EXPIRED") return "CANCELLED";
  if (s === "OPEN") return "OPEN";
  return "PENDING";
}

const FALLBACK_INDEX_IDS: Record<string, string> = {
  NIFTY50: "13", BANKNIFTY: "25", FINNIFTY: "27",
};

export class DhanAdapter implements BrokerAdapter {
  readonly capabilities = DHAN_CAPABILITIES;
  private client: DhanClient;

  constructor(accessToken: string, clientId: string) {
    this.client = new DhanClient(accessToken, clientId);
  }

  async searchInstruments(query: string, options?: { assetClass?: AssetClass; limit?: number }): Promise<Instrument[]> {
    const type = options?.assetClass === "ETF" ? "etf"
      : options?.assetClass === "EQUITY" ? "equity"
      : "all";
    const results = await dhanSearch(query, options?.limit ?? 20, type);
    return results.map(r => ({
      symbol: r.symbol,
      name: r.name,
      assetClass: (r.instrument_type === "ETF" ? "ETF" : "EQUITY") as AssetClass,
      market: "NSE",
    }));
  }

  async getQuote(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];

    // Separate equity/ETF symbols from index symbols
    const equityMap: Record<string, string> = {}; // symbol → secId
    const indexMap: Record<string, string> = {};  // symbol → secId

    await Promise.all(symbols.map(async (sym) => {
      const upper = sym.toUpperCase().replace(/[\s\-_]/g, "");
      const normalized = upper === "NIFTYBANK" ? "BANKNIFTY" : upper === "NIFTY" ? "NIFTY50" : upper;
      // Try index first
      let secId = await getIndexSecurityId(normalized);
      if (!secId) secId = FALLBACK_INDEX_IDS[normalized];
      if (secId) {
        indexMap[sym.toUpperCase()] = secId;
      } else {
        try {
          equityMap[sym.toUpperCase()] = await getSecurityId(sym);
        } catch {
          // symbol not found — skip
        }
      }
    }));

    const quotes: Quote[] = [];

    // Fetch equity quotes in batches of 25
    const equitySymbols = Object.keys(equityMap);
    const equityIds = Object.values(equityMap);
    const BATCH_SIZE = 25;
    for (let i = 0; i < equityIds.length; i += BATCH_SIZE) {
      const batchIds = equityIds.slice(i, i + BATCH_SIZE);
      const batchSyms = equitySymbols.slice(i, i + BATCH_SIZE);
      try {
        const result = await this.client.getQuote(batchIds, "NSE_EQ");
        const nseEq = ((result as Record<string, unknown>)["data"] as Record<string, unknown>)?.["NSE_EQ"] as Record<string, Record<string, unknown>> | undefined;
        if (nseEq) {
          const reverseMap: Record<string, string> = {};
          batchSyms.forEach((s, idx) => { reverseMap[batchIds[idx]] = s; });
          for (const [secId, q] of Object.entries(nseEq)) {
            const sym = reverseMap[secId] ?? secId;
            const lp = (q["last_price"] as number) ?? 0;
            const ohlc = q["ohlc"] as Record<string, number> | undefined;
            const pc = ohlc?.["close"] ?? 0;
            quotes.push({
              symbol: sym,
              lastPrice: lp,
              open: ohlc?.["open"] ?? 0,
              high: ohlc?.["high"] ?? 0,
              low: ohlc?.["low"] ?? 0,
              previousClose: pc,
              volume: (q["volume"] as number) ?? 0,
              change: +(lp - pc).toFixed(2),
              changePercent: pc ? +((lp - pc) / pc * 100).toFixed(2) : 0,
            });
          }
        }
      } catch (err) {
        console.warn("[DhanAdapter] equity quote batch failed:", err instanceof Error ? err.message : err);
      }
    }

    // Fetch index quotes
    const indexSymbols = Object.keys(indexMap);
    const indexIds = Object.values(indexMap);
    if (indexIds.length > 0) {
      try {
        const result = await this.client.getQuote(indexIds, "IDX_I");
        const idxData = ((result as Record<string, unknown>)["data"] as Record<string, unknown>)?.["IDX_I"] as Record<string, Record<string, unknown>> | undefined;
        if (idxData) {
          const reverseMap: Record<string, string> = {};
          indexSymbols.forEach((s, idx) => { reverseMap[indexIds[idx]] = s; });
          for (const [secId, q] of Object.entries(idxData)) {
            const sym = reverseMap[secId] ?? secId;
            const lp = (q["last_price"] as number) ?? 0;
            const ohlc = q["ohlc"] as Record<string, number> | undefined;
            const pc = ohlc?.["close"] ?? 0;
            quotes.push({
              symbol: sym,
              lastPrice: lp,
              open: ohlc?.["open"] ?? 0,
              high: ohlc?.["high"] ?? 0,
              low: ohlc?.["low"] ?? 0,
              previousClose: pc,
              volume: 0,
              change: +(lp - pc).toFixed(2),
              changePercent: pc ? +((lp - pc) / pc * 100).toFixed(2) : 0,
            });
          }
        }
      } catch (err) {
        console.warn("[DhanAdapter] index quote batch failed:", err instanceof Error ? err.message : err);
      }
    }

    return quotes;
  }

  async getHistory(symbol: string, interval: CandleInterval, from: Date, to: Date): Promise<Candle[]> {
    let normalized = symbol.toUpperCase().replace(/[\s\-_]/g, "");
    if (normalized === "NIFTYBANK") normalized = "BANKNIFTY";
    if (normalized === "NIFTY") normalized = "NIFTY50";

    let securityId = await getIndexSecurityId(normalized);
    if (!securityId) securityId = FALLBACK_INDEX_IDS[normalized];
    let exchangeSegment: "NSE_EQ" | "IDX_I";
    let instrumentType: "EQUITY" | "INDEX";

    if (securityId) {
      exchangeSegment = "IDX_I";
      instrumentType = "INDEX";
    } else {
      securityId = await getSecurityId(symbol);
      exchangeSegment = "NSE_EQ";
      instrumentType = "EQUITY";
    }

    const fmt = (d: Date) => d.toISOString().split("T")[0];
    const raw = await this.client.getHistory(securityId, toDhanInterval(interval), fmt(from), fmt(to), exchangeSegment, instrumentType);
    return parseDhanCandles(raw);
  }

  async getMarketDepth(symbol: string): Promise<OrderBook> {
    const securityId = await getSecurityId(symbol);
    const raw = await this.client.getMarketDepth(securityId) as Record<string, unknown>;
    const depthData = (raw["data"] as Record<string, unknown>)?.["NSE_EQ"] as Record<string, Record<string, unknown>> | undefined;
    const entry = depthData ? Object.values(depthData)[0] : null;
    const depth = (entry?.["depth"] as Record<string, unknown>) ?? {};
    const buy = ((depth["buy"] ?? depth["buyQuantity"]) as Array<Record<string, number>> | undefined) ?? [];
    const sell = ((depth["sell"] ?? depth["sellQuantity"]) as Array<Record<string, number>> | undefined) ?? [];
    return {
      symbol: symbol.toUpperCase(),
      bids: buy.map(b => ({ price: b["price"] ?? 0, quantity: b["quantity"] ?? 0 })),
      asks: sell.map(s => ({ price: s["price"] ?? 0, quantity: s["quantity"] ?? 0 })),
      timestamp: new Date(),
    };
  }

  async getPositions(): Promise<Position[]> {
    const raw = await this.client.getPositions() as Array<Record<string, unknown>> | Record<string, unknown>;
    const posData = Array.isArray(raw) ? raw : [];
    const positions: Position[] = [];
    for (const p of posData) {
      const qty = (p["netQty"] as number) ?? 0;
      if (qty === 0) continue;
      const avg = (p["costPrice"] as number) ?? (p["avgCostPrice"] as number) ?? 0;
      const lp = (p["lastTradedPrice"] as number) ?? (p["ltp"] as number) ?? 0;
      const productType = String(p["productType"] ?? "INTRADAY").toUpperCase();
      positions.push({
        symbol: (p["tradingSymbol"] as string) ?? "",
        side: qty > 0 ? "LONG" : "SHORT",
        quantity: Math.abs(qty),
        avgEntryPrice: avg,
        lastPrice: lp,
        unrealizedPnl: +((lp - avg) * qty).toFixed(2),
        productType: productType === "CNC" ? "DELIVERY" : "INTRADAY",
      });
    }
    return positions;
  }

  async getFunds(): Promise<Funds> {
    const raw = await this.client.getFunds() as Record<string, unknown>;
    const available = (raw["availabelBalance"] as number) ?? (raw["availableBalance"] as number) ?? 0;
    const used = (raw["utilizedAmount"] as number) ?? (raw["usedMargin"] as number) ?? 0;
    return {
      currency: "INR",
      cash: { available, used },
      margin: { available, used },
    };
  }

  async getOrders(): Promise<Order[]> {
    const raw = await this.client.getOrders() as unknown;
    const orderData = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
    return orderData.map(o => {
      const dhanStatus = String(o["orderStatus"] ?? o["order_status"] ?? "PENDING");
      const status = parseDhanOrderStatus(dhanStatus);
      const statusMessage = String(o["rejectReason"] ?? o["remarks"] ?? "") || undefined;
      return {
        orderId: String(o["orderId"] ?? o["order_id"] ?? ""),
        symbol: String(o["tradingSymbol"] ?? o["trading_symbol"] ?? ""),
        side: (String(o["transactionType"] ?? "BUY").toUpperCase() as "BUY" | "SELL"),
        quantity: (o["quantity"] as number) ?? 0,
        filledQuantity: (o["filledQty"] as number) ?? 0,
        orderType: (String(o["orderType"] ?? "MARKET").toUpperCase() as "MARKET" | "LIMIT"),
        productType: String(o["productType"] ?? "INTRADAY").toUpperCase() === "CNC" ? "DELIVERY" : "INTRADAY",
        price: (o["price"] as number) || undefined,
        status,
        statusMessage,
        placedAt: new Date(String(o["createTime"] ?? o["orderTime"] ?? new Date().toISOString())),
        updatedAt: new Date(String(o["updateTime"] ?? o["exchangeTime"] ?? o["createTime"] ?? new Date().toISOString())),
      };
    });
  }

  async getOrderById(orderId: string): Promise<Order> {
    const raw = await this.client.getOrderById(orderId) as Record<string, unknown>;
    const dhanStatus = String(raw["orderStatus"] ?? raw["order_status"] ?? "PENDING");
    const status = parseDhanOrderStatus(dhanStatus);
    return {
      orderId: String(raw["orderId"] ?? raw["order_id"] ?? orderId),
      symbol: String(raw["tradingSymbol"] ?? raw["trading_symbol"] ?? ""),
      side: (String(raw["transactionType"] ?? "BUY").toUpperCase() as "BUY" | "SELL"),
      quantity: (raw["quantity"] as number) ?? 0,
      filledQuantity: (raw["filledQty"] as number) ?? 0,
      orderType: (String(raw["orderType"] ?? "MARKET").toUpperCase() as "MARKET" | "LIMIT"),
      productType: String(raw["productType"] ?? "INTRADAY").toUpperCase() === "CNC" ? "DELIVERY" : "INTRADAY",
      price: ((raw["tradedPrice"] as number) ?? (raw["avgTradedPrice"] as number) ?? (raw["price"] as number)) || undefined,
      status,
      statusMessage: String(raw["rejectReason"] ?? raw["remarks"] ?? "") || undefined,
      placedAt: new Date(String(raw["createTime"] ?? new Date().toISOString())),
      updatedAt: new Date(String(raw["updateTime"] ?? raw["exchangeTime"] ?? raw["createTime"] ?? new Date().toISOString())),
    };
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    const securityId = await getSecurityId(params.symbol);
    const productType = params.productType === "DELIVERY" ? "CNC" : "INTRADAY";
    const raw = await this.client.placeOrder({
      symbol: params.symbol,
      securityId,
      transactionType: params.side,
      quantity: params.quantity,
      orderType: params.orderType as "MARKET" | "LIMIT",
      productType,
      price: params.price,
    }) as Record<string, unknown>;
    const orderId = String(raw["orderId"] ?? "");
    return { orderId, status: "PENDING" };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.client.cancelOrder(orderId);
  }

  async getTradebook(): Promise<Trade[]> {
    const raw = await this.client.getTradebook() as unknown;
    const tradeData = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
    return tradeData.map(t => ({
      tradeId: String(t["exchangeTradeId"] ?? t["trade_id"] ?? t["tradeId"] ?? ""),
      orderId: String(t["orderId"] ?? t["order_id"] ?? ""),
      symbol: String(t["tradingSymbol"] ?? t["symbol"] ?? ""),
      side: (String(t["transactionType"] ?? "BUY").toUpperCase() as "BUY" | "SELL"),
      quantity: (t["tradedQuantity"] as number) ?? (t["quantity"] as number) ?? 0,
      price: (t["tradedPrice"] as number) ?? (t["traded_price"] as number) ?? 0,
      productType: String(t["productType"] ?? "INTRADAY").toUpperCase() === "CNC" ? "DELIVERY" : "INTRADAY",
      tradedAt: new Date(String(t["updateTime"] ?? t["exchangeTime"] ?? t["createTime"] ?? new Date().toISOString())),
    }));
  }
}
