# VibeTrade

An AI-powered trading assistant for NSE (India) built on Claude. Chat naturally to get quotes, analyse charts, place orders, set price alerts, and run autonomous trading schedules — all from a single interface.

## Stack

| Layer | Tech |
|---|---|
| Frontend | Next.js (TypeScript) |
| Backend | Fastify + TypeScript |
| AI | Claude (claude-sonnet-4-6) via Anthropic SDK |
| Broker | [Dhan](https://dhan.co) API |
| Market data | Yahoo Finance, Dhan chart API |

## Features

- **Live quotes** — LTP, OHLC for equities, ETFs, and NSE indices
- **Historical charts + indicators** — RSI, MACD, Bollinger Bands, SMA, EMA, ATR
- **Fundamentals** — PE, EPS, market cap, dividend yield via Yahoo Finance
- **Market depth** — bid/ask ladder for any NSE equity
- **Order placement** — market and limit orders with user approval flow
- **Price triggers** — register conditions (e.g. "alert me when RELIANCE > ₹1500") that fire automatically
- **Cron schedules** — let Claude run on a schedule (e.g. "scan top movers every morning at 9:20")
- **Strategy tracking** — group trades into strategies, view P&L, win rate, open positions
- **Persistent memory** — Claude remembers your preferences and context across sessions
- **ETF analysis** — expense ratio, AUM, NAV, top holdings, sector weights

## Project Structure

```
backend/
  src/
    server.ts           # Fastify entry point
    routes/chat.ts      # WebSocket chat loop + tool execution
    lib/
      tools.ts          # All Claude tool definitions
      dhan/             # Dhan API client + instrument master
      storage/          # JSONL conversation store, memory, trades
      heartbeat/        # Trigger + schedule runner
      indicators.ts     # Technical indicator computations
      yahoo.ts          # Yahoo Finance fundamentals + ETF data
      news.ts           # LiveMint RSS news feed
      market-calendar.ts# NSE trading day / holiday calendar
  data/                 # Runtime data (gitignored)

frontend/
  src/
    app/                # Next.js app router
    components/         # Chat, sidebar panels, approval cards
    hooks/              # WebSocket + state hooks
```

## Setup

### Prerequisites

- Node.js 20+
- A [Dhan](https://dhan.co) trading account with API access
- An [Anthropic](https://console.anthropic.com) API key

### Environment Variables

Create `backend/.env`:

```env
DHAN_ACCESS_TOKEN=your_dhan_access_token
DHAN_CLIENT_ID=your_dhan_client_id
ANTHROPIC_API_KEY=your_anthropic_api_key
```

> Dhan access tokens expire every 30 days. Update `DHAN_ACCESS_TOKEN` and restart the backend when prompted.

### Run

```bash
# Backend (port 3001)
cd backend && npm install && npm run dev

# Frontend (port 3000)
cd frontend && npm install && npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## How It Works

1. You chat with Claude in the browser via a WebSocket connection.
2. Claude decides which tools to call (quotes, orders, etc.) based on your message.
3. Read-only tools run immediately; destructive actions (orders, triggers with hard orders) require your explicit approval in the UI.
4. Tool results are fed back to Claude, which synthesises a response.
5. The heartbeat runner evaluates registered price triggers and cron schedules in the background.

## Architecture Decisions

See [`ADR/`](./ADR/) for design decisions covering storage, scheduling, trade records, and more.
