import type { Candle } from "../indicators.js";

export type { Candle };

export type AssetClass = 'EQUITY' | 'ETF' | 'INDEX' | 'FUTURES' | 'OPTIONS' | 'CRYPTO_SPOT' | 'CRYPTO_PERP';
export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
export type ProductType = 'DELIVERY' | 'INTRADAY' | 'MARGIN' | 'SPOT' | 'PERP';
export type TimeInForce = 'DAY' | 'IOC' | 'GTC';
export type CandleInterval = '1m' | '5m' | '15m' | '25m' | '1h' | '1d';
export type OrderStatus = 'PENDING' | 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';

export interface BrokerCapabilities {
  name: string;
  markets: string[];
  assetClasses: AssetClass[];
  supportsHistoricalData: boolean;
  supportsMarketDepth: boolean;
  supportsStreaming: boolean;
  supportsFractionalQuantity: boolean;
  availableIndices: string[];
}

export interface Position {
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  avgEntryPrice: number;
  lastPrice: number;
  unrealizedPnl: number;
  productType: ProductType;
  marginUsed?: number;
}

export interface Funds {
  currency: string;
  cash: { available: number; used: number };
  margin: { available: number; used: number };
}

export interface Quote {
  symbol: string;
  lastPrice: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  volume: number;
  change: number;
  changePercent: number;
}

export interface OrderBook {
  symbol: string;
  bids: Array<{ price: number; quantity: number }>;
  asks: Array<{ price: number; quantity: number }>;
  timestamp: Date;
}

export interface Instrument {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  market?: string;
}

export interface Order {
  orderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  filledQuantity: number;
  orderType: OrderType;
  productType: ProductType;
  price?: number;
  status: OrderStatus;
  statusMessage?: string;
  placedAt: Date;
  updatedAt: Date;
}

export interface OrderParams {
  symbol: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  productType: ProductType;
  price?: number;
  timeInForce?: TimeInForce;
}

export interface OrderResult {
  orderId: string;
  status: OrderStatus;
}

export interface Trade {
  tradeId: string;
  orderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  productType: ProductType;
  tradedAt: Date;
}

export interface BrokerAdapter {
  readonly capabilities: BrokerCapabilities;
  searchInstruments(query: string, options?: { assetClass?: AssetClass; limit?: number }): Promise<Instrument[]>;
  getQuote(symbols: string[]): Promise<Quote[]>;
  getHistory(symbol: string, interval: CandleInterval, from: Date, to: Date): Promise<Candle[]>;
  getMarketDepth(symbol: string): Promise<OrderBook>;
  getPositions(): Promise<Position[]>;
  getFunds(): Promise<Funds>;
  getOrders(): Promise<Order[]>;
  getOrderById(orderId: string): Promise<Order>;
  placeOrder(params: OrderParams): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  getTradebook(): Promise<Trade[]>;
}
