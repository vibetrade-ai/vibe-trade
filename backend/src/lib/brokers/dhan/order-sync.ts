import type { BrokerAdapter, OrderStatus } from "../types.js";
import type { TradeStore, TradeStatus } from "../../storage/types.js";
import { computeRealizedPnl } from "../../trade-utils.js";

function normalizedStatusToTradeStatus(status: OrderStatus): TradeStatus | null {
  if (status === "FILLED" || status === "PARTIALLY_FILLED") return "filled";
  if (status === "REJECTED") return "rejected";
  if (status === "CANCELLED") return "cancelled";
  return null;
}

export async function syncOrders(
  broker: BrokerAdapter,
  store: TradeStore,
): Promise<{ fillsUpdated: number; rejectedOrCancelled: number }> {
  try {
    const pending = await store.list({ status: "pending" });
    console.log(`[order-sync] ${pending.length} pending trades:`, pending.map(t => `${t.symbol}(${t.orderId})`));
    if (pending.length === 0) return { fillsUpdated: 0, rejectedOrCancelled: 0 };

    let fillsUpdated = 0;
    let rejectedOrCancelled = 0;

    // Pass 1 — fills from tradebook
    const tradebook = await broker.getTradebook();
    console.log(`[order-sync] tradebook: ${tradebook.length} entries`);

    const fillMap = new Map<string, typeof tradebook[0]>();
    for (const fill of tradebook) {
      if (fill.orderId) fillMap.set(fill.orderId, fill);
    }

    for (const trade of pending) {
      const fill = fillMap.get(trade.orderId);
      if (!fill) {
        console.log(`[order-sync] pass1: no tradebook match for ${trade.symbol} orderId=${trade.orderId}`);
        continue;
      }
      console.log(`[order-sync] pass1: matched ${trade.symbol} orderId=${trade.orderId}`);

      const executedPrice = fill.price;
      const filledAt = fill.tradedAt.toISOString();
      const patch: Parameters<TradeStore["update"]>[1] = { status: "filled", executedPrice, filledAt };

      if (trade.transactionType === "SELL" && executedPrice) {
        const priorBuys = (await store.list({ symbol: trade.symbol, status: "filled" }))
          .filter(t => t.transactionType === "BUY" && t.executedPrice && (!trade.strategyId || t.strategyId === trade.strategyId));
        const pnl = computeRealizedPnl(executedPrice, trade.quantity, priorBuys);
        if (pnl !== undefined) patch.realizedPnl = pnl;
      }

      await store.update(trade.id, patch);
      fillsUpdated++;
    }

    // Pass 2 — fills/rejections/cancellations from orders list
    const orders = await broker.getOrders();
    console.log(`[order-sync] orders: ${orders.length} entries`);

    const orderMap = new Map<string, typeof orders[0]>();
    for (const order of orders) {
      if (order.orderId) orderMap.set(order.orderId, order);
    }

    const stillPending = await store.list({ status: "pending" });
    console.log(`[order-sync] pass2: ${stillPending.length} still pending after pass1`);

    for (const trade of stillPending) {
      const order = orderMap.get(trade.orderId);
      if (!order) {
        console.log(`[order-sync] pass2: no order match for ${trade.symbol} orderId=${trade.orderId}`);
        continue;
      }

      const tradeStatus = normalizedStatusToTradeStatus(order.status);
      console.log(`[order-sync] pass2: ${trade.symbol} orderId=${trade.orderId} → status=${order.status}, tradeStatus=${tradeStatus}`);

      if (tradeStatus === "filled") {
        const executedPrice = order.price;
        const filledAt = order.updatedAt.toISOString();
        const patch: Parameters<TradeStore["update"]>[1] = { status: "filled", executedPrice, filledAt };
        if (trade.transactionType === "SELL" && executedPrice) {
          const priorBuys = (await store.list({ symbol: trade.symbol, status: "filled" }))
            .filter(t => t.transactionType === "BUY" && t.executedPrice && (!trade.strategyId || t.strategyId === trade.strategyId));
          const pnl = computeRealizedPnl(executedPrice, trade.quantity, priorBuys);
          if (pnl !== undefined) patch.realizedPnl = pnl;
        }
        await store.update(trade.id, patch);
        fillsUpdated++;
      } else if (tradeStatus === "rejected" || tradeStatus === "cancelled") {
        await store.update(trade.id, { status: tradeStatus, rejectionReason: order.statusMessage });
        rejectedOrCancelled++;
      }
    }

    return { fillsUpdated, rejectedOrCancelled };
  } catch (err) {
    console.error("[order-sync] syncOrders failed:", err);
    return { fillsUpdated: 0, rejectedOrCancelled: 0 };
  }
}
