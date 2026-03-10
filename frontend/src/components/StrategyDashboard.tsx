"use client";

import { useCallback, useEffect, useState } from "react";
import { getBackendHttpUrl } from "@/lib/backend-url";

// ── Types ──────────────────────────────────────────────────────────────────────

interface OpenPosition {
  symbol: string;
  quantity: number;
  avgBuyPrice: number;
  deployedCapital: number;
}

interface BestWorstTrade {
  symbol: string;
  pnl: number;
  date?: string;
}

interface Performance {
  strategyId: string;
  strategyName: string;
  allocation: number;
  deployedCapital: number;
  totalTrades: number;
  filledTrades: number;
  pendingTrades: number;
  buyTrades: number;
  sellTrades: number;
  totalRealizedPnl: number;
  winRate: number | null;
  bestTrade: BestWorstTrade | null;
  worstTrade: BestWorstTrade | null;
  openPositions: OpenPosition[];
}

interface TradeRecord {
  id: string;
  orderId: string;
  symbol: string;
  transactionType: "BUY" | "SELL";
  quantity: number;
  orderType: "MARKET" | "LIMIT";
  requestedPrice?: number;
  executedPrice?: number;
  status: "pending" | "filled" | "cancelled" | "rejected";
  realizedPnl?: number;
  note?: string;
  createdAt: string;
  filledAt?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return "₹" + Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function pnlClass(n: number | undefined) {
  if (n === undefined) return "text-gray-400";
  return n >= 0 ? "text-green-400" : "text-red-400";
}

function pnlSign(n: number) {
  return n >= 0 ? "+" : "";
}

// ── Stat tile ─────────────────────────────────────────────────────────────────

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-lg bg-gray-800/60 border border-gray-700/60 p-3 space-y-0.5">
      <p className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</p>
      <p className="text-base font-semibold text-white leading-tight">{value}</p>
      {sub && <p className="text-[10px] text-gray-500">{sub}</p>}
    </div>
  );
}

// ── Allocation bar ────────────────────────────────────────────────────────────

function AllocationBar({ deployed, allocation }: { deployed: number; allocation: number }) {
  const pct = allocation > 0 ? Math.min((deployed / allocation) * 100, 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] text-gray-500">
        <span>Deployed: {fmt(deployed)}</span>
        <span>Allocation: {fmt(allocation)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-700 overflow-hidden">
        <div
          className="h-full rounded-full bg-blue-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] text-gray-500">{pct.toFixed(1)}% deployed</p>
    </div>
  );
}

// ── Trade row ─────────────────────────────────────────────────────────────────

function TradeRow({ trade }: { trade: TradeRecord }) {
  const isBuy = trade.transactionType === "BUY";
  const price = trade.executedPrice ?? trade.requestedPrice;
  return (
    <tr className="border-t border-gray-700/40 hover:bg-gray-800/40 transition-colors">
      <td className="py-2 px-3 text-xs text-gray-300">{fmtDate(trade.filledAt ?? trade.createdAt)}</td>
      <td className="py-2 px-3 text-xs font-medium text-white">{trade.symbol}</td>
      <td className="py-2 px-3">
        <span className={`text-xs font-medium ${isBuy ? "text-green-400" : "text-red-400"}`}>{trade.transactionType}</span>
      </td>
      <td className="py-2 px-3 text-xs text-gray-300 text-right">{trade.quantity}</td>
      <td className="py-2 px-3 text-xs text-gray-300 text-right">{price !== undefined ? fmt(price) : "—"}</td>
      <td className={`py-2 px-3 text-xs text-right font-medium ${pnlClass(trade.realizedPnl)}`}>
        {trade.realizedPnl !== undefined ? `${pnlSign(trade.realizedPnl)}${fmt(trade.realizedPnl)}` : "—"}
      </td>
      <td className="py-2 px-3">
        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
          trade.status === "filled" ? "bg-green-900/30 text-green-400 border-green-800/40" :
          trade.status === "pending" ? "bg-amber-900/30 text-amber-400 border-amber-800/40" :
          "bg-gray-700/40 text-gray-400 border-gray-600/40"
        }`}>{trade.status}</span>
      </td>
    </tr>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function StrategyDashboard({ strategyId, onBack }: { strategyId: string; onBack: () => void }) {
  const [perf, setPerf] = useState<Performance | null>(null);
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [perfRes, tradesRes] = await Promise.all([
        fetch(`${getBackendHttpUrl()}/api/strategies/${strategyId}/performance`),
        fetch(`${getBackendHttpUrl()}/api/strategies/${strategyId}/trades`),
      ]);
      if (perfRes.ok) setPerf(await perfRes.json() as Performance);
      if (tradesRes.ok) setTrades(await tradesRes.json() as TradeRecord[]);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [strategyId]);

  useEffect(() => { void load(); }, [load]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch(`${getBackendHttpUrl()}/api/trades/sync`, { method: "POST" });
      if (res.ok) {
        const data = await res.json() as { updated: number; tradebookEntries: number };
        setSyncResult(`Synced ${data.tradebookEntries} fills, updated ${data.updated} records`);
        await load();
      }
    } catch {
      setSyncResult("Sync failed — check backend");
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden p-4 space-y-3 animate-pulse">
        {[1, 2, 3].map(i => <div key={i} className="h-16 rounded-lg bg-gray-800/40" />)}
      </div>
    );
  }

  if (!perf) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-gray-500 text-sm">Failed to load performance data</p>
      </div>
    );
  }

  const pnlPositive = perf.totalRealizedPnl >= 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 flex-shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-gray-400 hover:text-white transition-colors text-xs"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-white truncate">{perf.strategyName}</h2>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          title="Pull today's fills from Dhan"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-700/40 border border-gray-600/40 text-xs text-gray-300 hover:bg-gray-700 hover:text-white disabled:opacity-50 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {syncing ? "Syncing…" : "Sync fills"}
        </button>
      </div>

      {syncResult && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700/40 text-xs text-gray-300">
          {syncResult}
        </div>
      )}

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* P&L headline */}
        <div className={`rounded-xl border p-4 ${pnlPositive ? "bg-green-900/10 border-green-800/30" : "bg-red-900/10 border-red-800/30"}`}>
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Realized P&L</p>
          <p className={`text-2xl font-bold ${pnlPositive ? "text-green-400" : "text-red-400"}`}>
            {pnlSign(perf.totalRealizedPnl)}{fmt(perf.totalRealizedPnl)}
          </p>
          {perf.winRate !== null && (
            <p className="text-xs text-gray-500 mt-1">
              Win rate: <span className="text-gray-300">{(perf.winRate * 100).toFixed(0)}%</span>
            </p>
          )}
        </div>

        {/* Stat grid */}
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Total trades" value={perf.totalTrades} sub={`${perf.pendingTrades} pending`} />
          <Stat label="Fills" value={perf.filledTrades} sub={`${perf.buyTrades}B / ${perf.sellTrades}S`} />
          <Stat
            label="Best trade"
            value={perf.bestTrade ? <span className="text-green-400">{pnlSign(perf.bestTrade.pnl)}{fmt(perf.bestTrade.pnl)}</span> : "—"}
            sub={perf.bestTrade?.symbol}
          />
          <Stat
            label="Worst trade"
            value={perf.worstTrade ? <span className="text-red-400">{pnlSign(perf.worstTrade.pnl)}{fmt(perf.worstTrade.pnl)}</span> : "—"}
            sub={perf.worstTrade?.symbol}
          />
        </div>

        {/* Allocation bar */}
        <div className="rounded-lg bg-gray-800/60 border border-gray-700/60 p-3">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Capital deployment</p>
          <AllocationBar deployed={perf.deployedCapital} allocation={perf.allocation} />
        </div>

        {/* Open positions */}
        {perf.openPositions.length > 0 && (
          <div>
            <p className="text-xs font-medium text-gray-400 mb-2">Open positions</p>
            <div className="rounded-lg border border-gray-700/60 overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-800/80">
                  <tr>
                    <th className="py-2 px-3 text-left text-[10px] text-gray-500 font-medium uppercase tracking-wider">Symbol</th>
                    <th className="py-2 px-3 text-right text-[10px] text-gray-500 font-medium uppercase tracking-wider">Qty</th>
                    <th className="py-2 px-3 text-right text-[10px] text-gray-500 font-medium uppercase tracking-wider">Avg price</th>
                    <th className="py-2 px-3 text-right text-[10px] text-gray-500 font-medium uppercase tracking-wider">Deployed</th>
                  </tr>
                </thead>
                <tbody className="bg-gray-900/40">
                  {perf.openPositions.map(pos => (
                    <tr key={pos.symbol} className="border-t border-gray-700/40">
                      <td className="py-2 px-3 text-xs font-medium text-white">{pos.symbol}</td>
                      <td className="py-2 px-3 text-xs text-gray-300 text-right">{pos.quantity}</td>
                      <td className="py-2 px-3 text-xs text-gray-300 text-right">{fmt(pos.avgBuyPrice)}</td>
                      <td className="py-2 px-3 text-xs text-gray-300 text-right">{fmt(pos.deployedCapital)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Trade log */}
        <div>
          <p className="text-xs font-medium text-gray-400 mb-2">Trade history</p>
          {trades.length === 0 ? (
            <p className="text-xs text-gray-600 text-center py-6">No trades recorded yet</p>
          ) : (
            <div className="rounded-lg border border-gray-700/60 overflow-hidden overflow-x-auto">
              <table className="w-full min-w-[580px]">
                <thead className="bg-gray-800/80">
                  <tr>
                    <th className="py-2 px-3 text-left text-[10px] text-gray-500 font-medium uppercase tracking-wider">Date</th>
                    <th className="py-2 px-3 text-left text-[10px] text-gray-500 font-medium uppercase tracking-wider">Symbol</th>
                    <th className="py-2 px-3 text-left text-[10px] text-gray-500 font-medium uppercase tracking-wider">Side</th>
                    <th className="py-2 px-3 text-right text-[10px] text-gray-500 font-medium uppercase tracking-wider">Qty</th>
                    <th className="py-2 px-3 text-right text-[10px] text-gray-500 font-medium uppercase tracking-wider">Price</th>
                    <th className="py-2 px-3 text-right text-[10px] text-gray-500 font-medium uppercase tracking-wider">P&L</th>
                    <th className="py-2 px-3 text-left text-[10px] text-gray-500 font-medium uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody className="bg-gray-900/40">
                  {trades.map(trade => <TradeRow key={trade.id} trade={trade} />)}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
