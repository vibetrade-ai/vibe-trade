import type { TradeRecord } from "./storage/types.js";

export interface OpenPosition {
  symbol: string;
  securityId: string;
  quantity: number;
  avgBuyPrice: number;
  deployedCapital: number;
}

/**
 * Compute net open positions from a set of filled TradeRecords.
 * BUYs add qty, SELLs reduce qty. Only returns symbols with qty > 0.
 */
export function computeOpenPositions(trades: TradeRecord[]): OpenPosition[] {
  const netQty: Record<string, { quantity: number; totalCost: number; securityId: string }> = {};
  for (const t of trades) {
    if (!netQty[t.symbol]) netQty[t.symbol] = { quantity: 0, totalCost: 0, securityId: t.securityId };
    if (t.transactionType === "BUY") {
      netQty[t.symbol].quantity += t.quantity;
      netQty[t.symbol].totalCost += (t.executedPrice ?? t.requestedPrice ?? 0) * t.quantity;
    } else {
      netQty[t.symbol].quantity -= t.quantity;
    }
  }
  return Object.entries(netQty)
    .filter(([, v]) => v.quantity > 0)
    .map(([symbol, v]) => ({
      symbol,
      securityId: v.securityId,
      quantity: v.quantity,
      avgBuyPrice: +(v.totalCost / v.quantity).toFixed(2),
      deployedCapital: +v.totalCost.toFixed(2),
    }));
}

/**
 * Compute realized P&L for a SELL fill given prior filled BUYs for the
 * same symbol (already filtered to matching strategyId if applicable).
 */
export function computeRealizedPnl(
  executedPrice: number,
  quantity: number,
  priorBuys: TradeRecord[],
): number | undefined {
  const totalQty = priorBuys.reduce((s, t) => s + t.quantity, 0);
  const totalCost = priorBuys.reduce((s, t) => s + (t.executedPrice! * t.quantity), 0);
  if (totalQty <= 0) return undefined;
  const avgCost = totalCost / totalQty;
  return +((executedPrice - avgCost) * quantity).toFixed(2);
}
