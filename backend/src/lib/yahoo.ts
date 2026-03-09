import YahooFinance from "yahoo-finance2";
const yahooFinance = new YahooFinance();

export interface Fundamentals {
  symbol: string;
  pe_ratio?: number;
  forward_pe?: number;
  eps?: number;
  revenue_growth?: number;
  profit_margins?: number;
  roe?: number;
  debt_to_equity?: number;
  market_cap?: number;
  sector?: string;
  industry?: string;
  fifty_two_week_high?: number;
  fifty_two_week_low?: number;
  avg_volume?: number;
}

async function safe<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

export async function getEtfInfo(symbol: string): Promise<object> {
  const yahooSymbol = symbol.toUpperCase().endsWith(".NS") ? symbol.toUpperCase() : `${symbol.toUpperCase()}.NS`;
  const [quoteSummary, quote] = await Promise.all([
    safe(yahooFinance.quoteSummary(yahooSymbol, { modules: ["fundProfile", "topHoldings", "summaryDetail"] })),
    safe(yahooFinance.quote(yahooSymbol)),
  ]);
  const qs = quoteSummary as any;
  const fundProfile = qs?.fundProfile;
  const topHoldings = qs?.topHoldings;
  const holdings = (topHoldings?.holdings ?? []).slice(0, 10)
    .map((h: any) => ({ symbol: h.symbol ?? "", name: h.holdingName ?? "", weight: h.holdingPercent ?? 0 }));
  const sectorWeightings = (topHoldings?.sectorWeightings ?? [])
    .flatMap((sw: any) => Object.entries(sw).filter(([, v]) => typeof v === "number").map(([sector, weight]) => ({ sector, weight })));
  return {
    symbol: symbol.toUpperCase(),
    fund_family: fundProfile?.family,
    category: fundProfile?.categoryName,
    legal_type: fundProfile?.legalType,
    expense_ratio: fundProfile?.feesExpensesInvestment?.annualReportExpenseRatio,
    net_assets: fundProfile?.feesExpensesInvestment?.totalNetAssets,
    nav: (quote as any)?.regularMarketPrice,
    fifty_two_week_high: (quote as any)?.fiftyTwoWeekHigh,
    fifty_two_week_low: (quote as any)?.fiftyTwoWeekLow,
    avg_volume: (quote as any)?.averageDailyVolume3Month,
    price_to_earnings: topHoldings?.equityHoldings?.priceToEarnings,
    price_to_book: topHoldings?.equityHoldings?.priceToBook,
    top_holdings: holdings.length > 0 ? holdings : undefined,
    sector_weightings: sectorWeightings.length > 0 ? sectorWeightings : undefined,
  };
}

export async function getVixQuote(): Promise<{ symbol: string; lastPrice: number } | null> {
  try {
    const quote = await yahooFinance.quote("^INDIAVIX");
    const price = (quote as any)?.regularMarketPrice ?? (quote as any)?.price ?? null;
    if (price == null) return null;
    return { symbol: "^INDIAVIX", lastPrice: price as number };
  } catch {
    return null;
  }
}

export async function getFundamentals(symbol: string): Promise<Fundamentals> {
  // NSE symbols use .NS suffix on Yahoo Finance
  const yahooSymbol = symbol.toUpperCase().endsWith(".NS")
    ? symbol.toUpperCase()
    : `${symbol.toUpperCase()}.NS`;

  const [quoteSummary, quote] = await Promise.all([
    safe(
      yahooFinance.quoteSummary(yahooSymbol, {
        modules: ["defaultKeyStatistics", "financialData", "assetProfile", "summaryDetail"],
      })
    ),
    safe(yahooFinance.quote(yahooSymbol)),
  ]);

  const qs = quoteSummary as any;
  const keyStats = qs?.defaultKeyStatistics;
  const financialData = qs?.financialData;
  const assetProfile = qs?.assetProfile;
  const summaryDetail = qs?.summaryDetail;

  return {
    symbol: symbol.toUpperCase(),
    pe_ratio: summaryDetail?.trailingPE ?? (quote as any)?.trailingPE ?? undefined,
    forward_pe: summaryDetail?.forwardPE ?? (quote as any)?.forwardPE ?? undefined,
    eps: keyStats?.trailingEps ?? undefined,
    revenue_growth: financialData?.revenueGrowth ?? undefined,
    profit_margins: financialData?.profitMargins ?? undefined,
    roe: financialData?.returnOnEquity ?? undefined,
    debt_to_equity: financialData?.debtToEquity ?? undefined,
    market_cap: (quote as any)?.marketCap ?? summaryDetail?.marketCap ?? undefined,
    sector: (assetProfile as any)?.sector ?? undefined,
    industry: (assetProfile as any)?.industry ?? undefined,
    fifty_two_week_high: (quote as any)?.fiftyTwoWeekHigh ?? summaryDetail?.fiftyTwoWeekHigh ?? undefined,
    fifty_two_week_low: (quote as any)?.fiftyTwoWeekLow ?? summaryDetail?.fiftyTwoWeekLow ?? undefined,
    avg_volume: (quote as any)?.averageDailyVolume3Month ?? summaryDetail?.averageVolume ?? undefined,
  };
}
