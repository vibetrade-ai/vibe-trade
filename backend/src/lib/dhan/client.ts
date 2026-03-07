import { DhanTokenExpiredError } from "../../types.js";

const BASE_URL = "https://api.dhan.co/v2";

interface DhanErrorResponse {
  errorCode?: string;
  errorMessage?: string;
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
    const res = await fetch(url, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    // Check for token expiry
    if (typeof data === "object" && data !== null) {
      const err = data as DhanErrorResponse;
      if (err.errorCode === "DH-901") {
        throw new DhanTokenExpiredError();
      }
    }

    if (!res.ok) {
      if (typeof data === "object" && data !== null) {
        const errData = data as DhanErrorResponse;
        const code = errData.errorCode ? ` [${errData.errorCode}]` : "";
        const msg = errData.errorMessage ?? JSON.stringify(data);
        throw new Error(`Dhan API error ${res.status}${code}: ${msg}`);
      }
      throw new Error(`Dhan API error ${res.status}: ${String(data) || res.statusText}`);
    }

    return data as T;
  }

  async getQuote(securityIds: string[]): Promise<unknown> {
    // Dhan v2 market quote: POST /marketfeed/ltp
    return this.request("POST", "/marketfeed/ltp", {
      NSE_EQ: securityIds,
    });
  }

  async getIndexQuote(index: string): Promise<unknown> {
    // Map index name to Dhan index security IDs
    const indexMap: Record<string, string[]> = {
      NIFTY50: ["13"],
      NIFTY_50: ["13"],
      BANKNIFTY: ["25"],
      BANK_NIFTY: ["25"],
      FINNIFTY: ["27"],
      FIN_NIFTY: ["27"],
    };
    const normalized = index.toUpperCase().replace(/[\s-]/g, "_").replace("NIFTY_BANK", "BANKNIFTY");
    const ids = indexMap[normalized] ?? indexMap[index.toUpperCase()];
    if (!ids) {
      throw new Error(`Unknown index: ${index}. Supported: NIFTY50, BANKNIFTY, FINNIFTY`);
    }
    return this.request("POST", "/marketfeed/ltp", {
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
}
