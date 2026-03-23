import type { IntentPrimitive } from "@/lib/api";

interface Props {
  primitives: IntentPrimitive[];
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 2) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function relativeTimeFuture(iso: string): string {
  const date = new Date(iso);
  const diff = date.getTime() - Date.now();
  const min = Math.round(diff / 60000);

  const timeStr = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (min < 1) return "just now";
  if (min < 60) return `in ${min} min (${timeStr})`;

  const h = Math.round(min / 60);

  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  if (isToday) return `today at ${timeStr}`;
  if (isTomorrow) return `tomorrow at ${timeStr}`;

  // Within a week — show day name
  if (h < 24 * 7) {
    const dayName = date.toLocaleDateString([], { weekday: "short" });
    return `${dayName} at ${timeStr}`;
  }

  // Further out — show date + time
  const dateStr = date.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${dateStr} at ${timeStr}`;
}

interface AutomationItem {
  dot: string;     // color
  icon: string;    // ●, ✓, ⏸, ⏳, ✗
  primary: string;
  secondary?: string;
}

function buildAutomationItem(p: IntentPrimitive): AutomationItem | null {
  if (p.type === "portfolio" || p.type === "strategy") return null;

  if (p.type === "trigger" && p.trigger) {
    const { name, status, scheduledAt, lastFiredAt } = p.trigger;

    if (status === "cancelled" || status === "expired") return null;

    if (status === "paused") {
      return { dot: "#F59E0B", icon: "⏸", primary: `${name} — paused` };
    }

    const hasFired = !!lastFiredAt;

    if (!hasFired) {
      // Not yet fired — forward-looking
      const secondary = scheduledAt ? `Scheduled ${relativeTimeFuture(scheduledAt)}` : undefined;
      return { dot: "#22C55E", icon: "●", primary: name, secondary };
    }

    // Trigger has fired — look for trade outcome in same primitives context
    // We handle trade linkage via parent — for now show fired state
    return { dot: "#00C9A7", icon: "✓", primary: name, secondary: `Condition met · ${relativeTime(lastFiredAt)}` };
  }

  if (p.type === "order" && p.trade) {
    const { symbol, status, quantity, transactionType, executedPrice } = p.trade;
    const dir = transactionType === "SELL" ? "Sold" : "Bought";
    const dirUpper = transactionType ?? "BUY";

    if (status === "filled") {
      const price = executedPrice ? ` at ₹${executedPrice.toLocaleString("en-IN")}` : "";
      return { dot: "#00C9A7", icon: "✓", primary: `${dir} ${quantity} ${symbol}${price}` };
    }
    if (status === "pending") {
      return { dot: "#F59E0B", icon: "⏳", primary: `${dirUpper} ${quantity} ${symbol} — waiting to fill` };
    }
    if (status === "rejected") {
      return { dot: "#EF4444", icon: "✗", primary: `${dirUpper} ${quantity} ${symbol} — rejected` };
    }
    return { dot: "#6B7280", icon: "●", primary: `${dirUpper} ${quantity} ${symbol}` };
  }

  return null;
}

export function PrimitiveList({ primitives }: Props) {
  // Build automation items, handling trigger+trade pairs
  const items: AutomationItem[] = [];
  const usedOrderIds = new Set<number>();

  for (let i = 0; i < primitives.length; i++) {
    const p = primitives[i];
    if (p.type === "portfolio" || p.type === "strategy") continue;

    if (p.type === "trigger" && p.trigger) {
      const { name, status, scheduledAt, lastFiredAt } = p.trigger;
      if (status === "cancelled" || status === "expired") continue;

      if (status === "paused") {
        items.push({ dot: "#F59E0B", icon: "⏸", primary: `${name} — paused` });
        continue;
      }

      const hasFired = !!lastFiredAt;

      if (!hasFired) {
        const secondary = scheduledAt ? `Scheduled ${relativeTimeFuture(scheduledAt)}` : undefined;
        items.push({ dot: "#22C55E", icon: "●", primary: name, secondary });
        continue;
      }

      // Fired — look for adjacent order primitive
      const nextP = primitives[i + 1];
      if (nextP && nextP.type === "order" && nextP.trade) {
        usedOrderIds.add(i + 1);
        const { symbol, quantity, transactionType, executedPrice, status: tradeStatus } = nextP.trade;
        const dir = transactionType === "SELL" ? "sold" : "bought";
        let secondary: string;
        if (tradeStatus === "filled") {
          const price = executedPrice ? ` at ₹${executedPrice.toLocaleString("en-IN")}` : "";
          secondary = `Condition met · ${dir} ${quantity} ${symbol}${price} · ${relativeTime(lastFiredAt)}`;
        } else if (tradeStatus === "pending") {
          secondary = `Condition met · order placed for ${quantity} ${symbol} — waiting to fill`;
        } else {
          secondary = `Condition met · no action taken · ${relativeTime(lastFiredAt)}`;
        }
        items.push({ dot: "#00C9A7", icon: "✓", primary: name, secondary });
      } else {
        items.push({ dot: "#00C9A7", icon: "✓", primary: name, secondary: `Condition met · no action taken · ${relativeTime(lastFiredAt)}` });
      }
      continue;
    }

    if (p.type === "order" && !usedOrderIds.has(i)) {
      const item = buildAutomationItem(p);
      if (item) items.push(item);
    }
  }

  if (items.length === 0) {
    return <p style={{ fontSize: "14px", color: "#9CA3AF", fontStyle: "italic" }}>No automations yet.</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {items.map((item, i) => (
        <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
          <span style={{
            display: "inline-block",
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: item.dot,
            marginTop: "4px",
            flexShrink: 0,
          }} />
          <div>
            <p style={{ fontSize: "13px", fontWeight: "600", color: "#111827", margin: 0, lineHeight: "1.4" }}>
              {item.icon !== "●" && item.icon !== "⏸" ? `${item.icon} ` : ""}{item.primary}
            </p>
            {item.secondary && (
              <p style={{ fontSize: "12px", color: "#9CA3AF", margin: "2px 0 0 0", lineHeight: "1.4" }}>
                {item.secondary}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
