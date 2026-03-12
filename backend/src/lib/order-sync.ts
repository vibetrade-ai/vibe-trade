import type { DhanClient } from "./dhan/client.js";
import type { TradeStore, TradeStatus } from "./storage/types.js";
import { computeRealizedPnl } from "./trade-utils.js";

export function parseOrderStatus(order: Record<string, unknown>): {
  dhanStatus: string;
  tradeStatus: TradeStatus | null;
  executedPrice?: number;
  filledAt?: string;
  rejectionReason?: string;
} {
  const dhanStatus = String(order["orderStatus"] ?? order["order_status"] ?? "UNKNOWN").toUpperCase();
  const executedPrice = (order["tradedPrice"] ?? order["avgTradedPrice"]) as number | undefined;
  const filledAt = String(order["updateTime"] ?? order["exchangeTime"] ?? order["createTime"] ?? "");
  const rejectionReason = String(order["rejectReason"] ?? order["remarks"] ?? "");

  if (dhanStatus === "TRADED" || dhanStatus === "PART_TRADED") {
    return {
      dhanStatus,
      tradeStatus: "filled",
      executedPrice: executedPrice ?? undefined,
      filledAt: filledAt || new Date().toISOString(),
    };
  }
  if (dhanStatus === "REJECTED") {
    return {
      dhanStatus,
      tradeStatus: "rejected",
      rejectionReason: rejectionReason || undefined,
    };
  }
  if (dhanStatus === "CANCELLED" || dhanStatus === "EXPIRED") {
    return { dhanStatus, tradeStatus: "cancelled" };
  }
  // TRANSIT / PENDING / OPEN / unknown — no update needed
  return { dhanStatus, tradeStatus: null };
}

export async function syncOrders(
  client: DhanClient,
  store: TradeStore,
): Promise<{ fillsUpdated: number; rejectedOrCancelled: number }> {
  try {
    const pending = await store.list({ status: "pending" });
    console.log(`[order-sync] ${pending.length} pending trades:`, pending.map(t => `${t.symbol}(${t.orderId})`));
    if (pending.length === 0) return { fillsUpdated: 0, rejectedOrCancelled: 0 };

    let fillsUpdated = 0;
    let rejectedOrCancelled = 0;

    // Pass 1 — fills from tradebook
    const raw = await client.getTradebook();
    console.log(`[order-sync] tradebook: isArray=${Array.isArray(raw)}, type=${typeof raw}, keys=${raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw as object).join(",") : "N/A"}, sample=${JSON.stringify(raw).slice(0, 500)}`);
    const fills = Array.isArray(raw) ? raw : [];

    type DhanFill = Record<string, unknown>;
    const fillMap = new Map<string, DhanFill>();
    for (const fill of fills as DhanFill[]) {
      const oid = String(fill["orderId"] ?? fill["order_id"] ?? "");
      if (oid) fillMap.set(oid, fill);
    }

    for (const trade of pending) {
      const fill = fillMap.get(trade.orderId);
      if (!fill) {
        console.log(`[order-sync] pass1: no tradebook match for ${trade.symbol} orderId=${trade.orderId}`);
        continue;
      }
      console.log(`[order-sync] pass1: matched ${trade.symbol} orderId=${trade.orderId}`);

      const executedPrice = (fill["tradedPrice"] as number | undefined) ?? (fill["traded_price"] as number | undefined);
      const filledAt = String(fill["updateTime"] ?? fill["exchangeTime"] ?? fill["createTime"] ?? new Date().toISOString());
      const patch: Parameters<TradeStore["update"]>[1] = {
        status: "filled",
        executedPrice,
        filledAt,
      };

      // Compute realizedPnl for SELL fills
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
    const rawOrders = await client.getOrders();
    console.log(`[order-sync] orders: isArray=${Array.isArray(rawOrders)}, count=${Array.isArray(rawOrders) ? (rawOrders as unknown[]).length : "N/A"}`);
    const orders = Array.isArray(rawOrders) ? rawOrders : [];

    type DhanOrder = Record<string, unknown>;
    const orderMap = new Map<string, DhanOrder>();
    for (const order of orders as DhanOrder[]) {
      const oid = String(order["orderId"] ?? order["order_id"] ?? "");
      if (oid) orderMap.set(oid, order);
    }

    // Re-fetch still-pending (some may have just been filled above)
    const stillPending = await store.list({ status: "pending" });
    console.log(`[order-sync] pass2: ${stillPending.length} still pending after pass1`);
    for (const trade of stillPending) {
      const order = orderMap.get(trade.orderId);
      if (!order) {
        console.log(`[order-sync] pass2: no order match for ${trade.symbol} orderId=${trade.orderId}`);
        continue;
      }
      const parsed = parseOrderStatus(order);
      console.log(`[order-sync] pass2: ${trade.symbol} orderId=${trade.orderId} → dhanStatus=${parsed.dhanStatus}, tradeStatus=${parsed.tradeStatus}`);
      if (parsed.tradeStatus === "filled") {
        const patch: Parameters<TradeStore["update"]>[1] = {
          status: "filled",
          executedPrice: parsed.executedPrice,
          filledAt: parsed.filledAt,
        };
        if (trade.transactionType === "SELL" && parsed.executedPrice) {
          const priorBuys = (await store.list({ symbol: trade.symbol, status: "filled" }))
            .filter(t => t.transactionType === "BUY" && t.executedPrice && (!trade.strategyId || t.strategyId === trade.strategyId));
          const pnl = computeRealizedPnl(parsed.executedPrice, trade.quantity, priorBuys);
          if (pnl !== undefined) patch.realizedPnl = pnl;
        }
        await store.update(trade.id, patch);
        fillsUpdated++;
      } else if (parsed.tradeStatus === "rejected" || parsed.tradeStatus === "cancelled") {
        await store.update(trade.id, {
          status: parsed.tradeStatus,
          rejectionReason: parsed.rejectionReason,
        });
        rejectedOrCancelled++;
      }
    }

    return { fillsUpdated, rejectedOrCancelled };
  } catch (err) {
    console.error("[order-sync] syncOrders failed:", err);
    return { fillsUpdated: 0, rejectedOrCancelled: 0 };
  }
}
