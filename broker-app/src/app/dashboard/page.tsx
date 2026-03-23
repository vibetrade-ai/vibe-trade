"use client";
import { useState, useEffect, useCallback } from "react";
import { api, type Portfolio, type PortfolioPerformance, type OpenPosition, type TradeRecord } from "@/lib/api";
import { TopBar, BrokerPill } from "@/components/TopBar";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{
      background: "white",
      borderRadius: "var(--radius)",
      border: "1px solid var(--gray-200)",
      padding: "20px 22px",
      boxShadow: "var(--shadow-xs)",
    }}>
      <p style={{ margin: "0 0 6px", fontSize: "12px", fontWeight: "600", color: "var(--gray-400)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </p>
      <p style={{ margin: 0, fontSize: "22px", fontWeight: "700", color: color ?? "var(--gray-900)", letterSpacing: "-0.03em" }}>
        {value}
      </p>
      {sub && <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--gray-400)" }}>{sub}</p>}
    </div>
  );
}

export default function DashboardPage() {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [perfs, setPerfs] = useState<PortfolioPerformance[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [portList, intents] = await Promise.all([
        api.portfolios.list().catch(() => [] as Portfolio[]),
        api.intents.list("processing,clarifying,planning,active").catch(() => []),
      ]);
      setPortfolios(portList);
      setActiveCount(intents.length);
      if (portList.length > 0) {
        const perfResults = await Promise.all(
          portList.map(p => api.portfolios.getPerformance(p.id).catch(() => null))
        );
        setPerfs(perfResults.filter(Boolean) as PortfolioPerformance[]);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 10000);
    return () => clearInterval(interval);
  }, [load]);

  const totalDeployed = perfs.reduce((s, p) => s + p.deployedCapital, 0);
  const totalPnl = perfs.reduce((s, p) => s + p.totalRealizedPnl + p.unrealizedPnl, 0);
  const allPositions: OpenPosition[] = perfs.flatMap(p => p.openPositions);
  const allTrades: TradeRecord[] = perfs.flatMap(p => p.trades ?? []);
  const recentTrades = [...allTrades]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 6);

  const fmt = (n: number) => `₹${Math.abs(n).toLocaleString("en-IN")}`;
  const pnlColor = totalPnl >= 0 ? "var(--green)" : "var(--red)";

  return (
    <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
      <TopBar title="Dashboard" right={<BrokerPill />} />

      <div style={{ padding: "28px 32px", flex: 1 }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: "60px", color: "var(--gray-400)" }}>Loading...</div>
        ) : portfolios.length === 0 ? (
          <div style={{ textAlign: "center", padding: "80px 20px" }}>
            <p style={{ fontSize: "16px", fontWeight: "600", color: "var(--gray-500)", margin: "0 0 8px" }}>No portfolios yet</p>
            <p style={{ fontSize: "14px", color: "var(--gray-400)", margin: "0 0 20px" }}>Submit a trading intent from Chat to create your first autopilot</p>
            <a href="/" style={{
              display: "inline-block",
              padding: "9px 20px",
              background: "var(--gray-900)",
              color: "white",
              borderRadius: "var(--radius-xs)",
              textDecoration: "none",
              fontSize: "14px",
              fontWeight: "600",
            }}>
              Go to Chat →
            </a>
          </div>
        ) : (
          <>
            {/* Stats row */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: "16px",
              marginBottom: "28px",
            }}>
              <StatCard
                label="Deployed Capital"
                value={totalDeployed > 0 ? fmt(totalDeployed) : "--"}
              />
              <StatCard
                label="Total P&L"
                value={perfs.length > 0 ? `${totalPnl >= 0 ? "+" : "-"}${fmt(totalPnl)}` : "--"}
                color={perfs.length > 0 ? pnlColor : undefined}
              />
              <StatCard
                label="Active Autopilots"
                value={String(activeCount)}
                sub={activeCount === 1 ? "running" : "running"}
              />
              <StatCard
                label="Open Positions"
                value={String(allPositions.length)}
                sub={allPositions.length === 0 ? "none" : undefined}
              />
            </div>

            {/* 2-col grid */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
              {/* Open Positions */}
              <div style={{
                background: "white",
                borderRadius: "var(--radius)",
                border: "1px solid var(--gray-200)",
                boxShadow: "var(--shadow-xs)",
                overflow: "hidden",
              }}>
                <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--gray-100)" }}>
                  <h2 style={{ margin: 0, fontSize: "14px", fontWeight: "700", color: "var(--gray-800)" }}>Open Positions</h2>
                </div>
                {allPositions.length === 0 ? (
                  <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--gray-400)", fontSize: "14px" }}>
                    No open positions
                  </div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: "var(--gray-50)" }}>
                        {["Symbol", "Qty", "Avg", "P&L"].map(h => (
                          <th key={h} style={{
                            padding: "8px 14px",
                            fontSize: "11px",
                            fontWeight: "600",
                            color: "var(--gray-400)",
                            textAlign: "left",
                            letterSpacing: "0.05em",
                            textTransform: "uppercase",
                          }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {allPositions.map((pos, i) => (
                        <tr key={i} style={{ borderTop: "1px solid var(--gray-100)" }}>
                          <td style={{ padding: "10px 14px", fontSize: "13px", fontWeight: "600", color: "var(--gray-900)", fontFamily: "var(--font-mono)" }}>
                            {pos.symbol}
                          </td>
                          <td style={{ padding: "10px 14px", fontSize: "13px", color: "var(--gray-600)" }}>
                            {pos.quantity}
                          </td>
                          <td style={{ padding: "10px 14px", fontSize: "13px", color: "var(--gray-600)" }}>
                            ₹{pos.avgBuyPrice.toLocaleString("en-IN")}
                          </td>
                          <td style={{ padding: "10px 14px", fontSize: "13px", fontWeight: "600", color: (pos.unrealizedPnl ?? 0) >= 0 ? "var(--green)" : "var(--red)" }}>
                            {pos.unrealizedPnl != null ? `${pos.unrealizedPnl >= 0 ? "+" : ""}₹${pos.unrealizedPnl.toLocaleString("en-IN")}` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Recent Activity */}
              <div style={{
                background: "white",
                borderRadius: "var(--radius)",
                border: "1px solid var(--gray-200)",
                boxShadow: "var(--shadow-xs)",
                overflow: "hidden",
              }}>
                <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--gray-100)" }}>
                  <h2 style={{ margin: 0, fontSize: "14px", fontWeight: "700", color: "var(--gray-800)" }}>Recent Activity</h2>
                </div>
                {recentTrades.length === 0 ? (
                  <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--gray-400)", fontSize: "14px" }}>
                    No recent trades
                  </div>
                ) : (
                  <div>
                    {recentTrades.map(trade => (
                      <div key={trade.id} style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        padding: "12px 20px",
                        borderBottom: "1px solid var(--gray-100)",
                      }}>
                        <div style={{
                          width: "8px",
                          height: "8px",
                          borderRadius: "50%",
                          background: trade.transactionType === "BUY" ? "var(--green)" : "var(--red)",
                          flexShrink: 0,
                        }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ margin: 0, fontSize: "13px", fontWeight: "600", color: "var(--gray-900)" }}>
                            {trade.transactionType} {trade.quantity} {trade.symbol}
                          </p>
                          {trade.executedPrice && (
                            <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--gray-400)" }}>
                              @ ₹{trade.executedPrice.toLocaleString("en-IN")}
                            </p>
                          )}
                        </div>
                        <span style={{ fontSize: "11px", color: "var(--gray-400)", flexShrink: 0 }}>
                          {timeAgo(trade.createdAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
