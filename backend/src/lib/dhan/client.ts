import { DhanTokenExpiredError } from "../../types.js";

const BASE_URL = "https://api.dhan.co/v2";

interface DhanErrorResponse {
  errorCode?: string;
  errorMessage?: string;
  status?: string;
  data?: Record<string, string>; // keys are Dhan internal error codes, not security IDs
}

// Parses Dhan's two error formats:
//   { errorCode, errorMessage }                        — standard REST errors
//   { status: "failed", data: { "<errCode>": "msg" } } — market feed errors
//     Note: the keys in `data` are Dhan's internal error codes, NOT security IDs.
function parseDhanError(data: DhanErrorResponse, status: number): string {
  if (data.errorCode === "DH-901") return "TOKEN_EXPIRED";
  if (data.status === "failed" && data.data && typeof data.data === "object") {
    const details = Object.entries(data.data).map(([code, msg]) => `${msg} (code ${code})`).join(", ");
    return details || "Invalid Request";
  }
  if (data.errorMessage) {
    const code = data.errorCode ? ` [${data.errorCode}]` : "";
    return `${status}${code}: ${data.errorMessage}`;
  }
  return JSON.stringify(data);
}

export class DhanClient {
  private accessToken: string;
  private clientId: string;

  constructor() {
    this.accessToken = process.env.DHAN_ACCESS_TOKEN ?? "";
    this.clientId = process.env.DHAN_CLIENT_ID ?? "";
    if (!this.accessToken || !this.clientId) {
      throw new Error("DHAN_ACCESS_TOKEN and DHAN_CLIENT_ID must be set in environment variables");
    }
  }

  private headers(): Record<string, string> {
    return {
      "access-token": this.accessToken,
      "client-id": this.clientId,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(url, {
        method,
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined,
      });

      // Retry on 429 with backoff (respect Retry-After if provided)
      if (res.status === 429 && attempt < maxRetries) {
        const retryAfter = res.headers.get("Retry-After");
        const waitMs = retryAfter
          ? parseFloat(retryAfter) * 1000
          : (2 ** attempt) * 1000; // 1s, 2s, 4s
        console.warn(`[dhan] 429 rate-limited on ${method} ${path}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      const text = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }

      if (!res.ok) {
        if (typeof data === "object" && data !== null) {
          const message = parseDhanError(data as DhanErrorResponse, res.status);
          if (message === "TOKEN_EXPIRED") throw new DhanTokenExpiredError();
          throw new Error(`Dhan API error ${res.status}: ${message}`);
        }
        throw new Error(`Dhan API error ${res.status}: ${String(data) || res.statusText}`);
      }

      return data as T;
    }

    throw new Error(`Dhan API error 429: rate limit exceeded after ${maxRetries} retries on ${method} ${path}`);
  }

  async getQuote(securityIds: string[], segment: "NSE_EQ" | "IDX_I" = "NSE_EQ"): Promise<unknown> {
    return this.request("POST", "/marketfeed/ohlc", { [segment]: securityIds.map(Number) });
  }

  async getIndexQuote(index: string): Promise<unknown> {
    // Map index name to Dhan index security IDs
    const indexMap: Record<string, number[]> = {
      NIFTY50: [13],
      NIFTY_50: [13],
      BANKNIFTY: [25],
      BANK_NIFTY: [25],
      FINNIFTY: [27],
      FIN_NIFTY: [27],
    };
    const normalized = index.toUpperCase().replace(/[\s-]/g, "_").replace("NIFTY_BANK", "BANKNIFTY");
    const ids = indexMap[normalized] ?? indexMap[index.toUpperCase()];
    if (!ids) {
      throw new Error(`Unknown index: ${index}. Supported: NIFTY50, BANKNIFTY, FINNIFTY`);
    }
    return this.request("POST", "/marketfeed/ohlc", {
      IDX_I: ids,
    });
  }

  async getPositions(): Promise<unknown> {
    return this.request("GET", "/positions");
  }

  async getFunds(): Promise<unknown> {
    return this.request("GET", "/fundlimit");
  }

  async getOrders(): Promise<unknown> {
    return this.request("GET", "/orders");
  }

  async placeOrder(params: {
    symbol: string;
    securityId: string;
    transactionType: "BUY" | "SELL";
    quantity: number;
    orderType: "MARKET" | "LIMIT";
    price?: number;
  }): Promise<unknown> {
    const body: Record<string, unknown> = {
      dhanClientId: this.clientId,
      transactionType: params.transactionType,
      exchangeSegment: "NSE_EQ",
      productType: "INTRADAY",
      orderType: params.orderType,
      validity: "DAY",
      tradingSymbol: params.symbol,
      securityId: params.securityId,
      quantity: params.quantity,
    };
    if (params.orderType === "LIMIT" && params.price !== undefined) {
      body.price = params.price;
    } else {
      body.price = 0;
    }
    return this.request("POST", "/orders", body);
  }

  async cancelOrder(orderId: string): Promise<unknown> {
    return this.request("DELETE", `/orders/${orderId}`);
  }

  async getHistory(
    securityId: string,
    interval: "1" | "5" | "15" | "25" | "60" | "D",
    fromDate: string,
    toDate: string,
    exchangeSegment: "NSE_EQ" | "IDX_I" = "NSE_EQ",
    instrument: "EQUITY" | "INDEX" = "EQUITY"
  ): Promise<unknown> {
    if (interval === "D") {
      return this.request("POST", "/charts/historical", {
        securityId,
        exchangeSegment,
        instrument,
        expiryCode: 0,
        fromDate,
        toDate,
      });
    }
    return this.request("POST", "/charts/intraday", {
      securityId,
      exchangeSegment,
      instrument,
      interval,
      fromDate,
      toDate,
    });
  }

  async getMarketDepth(securityId: string): Promise<unknown> {
    return this.request("POST", "/marketfeed/full", {
      NSE_EQ: [Number(securityId)],
    });
  }

  async getTradebook(): Promise<unknown> {
    return this.request("GET", "/tradebook");
  }
}
