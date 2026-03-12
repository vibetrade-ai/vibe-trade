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
  const netQty: Record<string, { quantity: number; totalCost: number; totalProceeds: number; securityId: string }> = {};
  for (const t of trades) {
    if (!netQty[t.symbol]) netQty[t.symbol] = { quantity: 0, totalCost: 0, totalProceeds: 0, securityId: t.securityId };
    const price = t.executedPrice ?? t.requestedPrice ?? 0;
    if (t.transactionType === "BUY") {
      netQty[t.symbol].quantity += t.quantity;
      netQty[t.symbol].totalCost += price * t.quantity;
    } else {
      netQty[t.symbol].quantity -= t.quantity;
      netQty[t.symbol].totalProceeds += price * t.quantity;
    }
  }
  return Object.entries(netQty)
    .filter(([, v]) => v.quantity !== 0)
    .map(([symbol, v]) => ({
      symbol,
      securityId: v.securityId,
      quantity: v.quantity,
      avgBuyPrice: v.quantity > 0 
        ? +(v.totalCost / v.quantity).toFixed(2)
        : +(v.totalProceeds / Math.abs(v.quantity)).toFixed(2),
      deployedCapital: v.quantity > 0 ? +v.totalCost.toFixed(2) : +v.totalProceeds.toFixed(2),
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
