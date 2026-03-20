<div align="center">

# Vibe Trade

**AI trading agent for Indian stock markets (NSE). Describe your strategy in plain English — the agent builds the automation, monitors the market, and executes through your broker. Powered by Claude.**

Vibe Trade is a local AI trading agent powered by Claude. Describe your strategy in plain English — the agent writes the Playbook, builds the automation stack, monitors the market around the clock, and comes to you with a reasoned case before touching your account.

[![License: MIT](https://img.shields.io/badge/license-MIT-4DFF4D?labelColor=111)](LICENSE)
[![Powered by Claude](https://img.shields.io/badge/powered%20by-Claude-4DFF4D?labelColor=111)](https://anthropic.com)


[Docs](https://vibetrade-ai.github.io/docs) · [How it works](#how-it-works) · [Talk to the founders](https://calendly.com/sahil-revise/30min-meeting)

</div>

---

<div align="center">

![Vibe Trade Demo](assets/demo.gif)

</div>

---

## Talk to your portfolio — with live data

Ask the agent anything. It has 20 built-in tools and a live broker connection. It fetches real prices, reads your open positions, pulls candles and indicators, and scans the news — then answers like a portfolio manager who's been watching all morning.

```
you:   what's the weakest position right now?

agent: ONGC SHORT is the most at risk. RSI has climbed to 56 —
       short momentum is fading. You're at −1.02% with the hard
       SL only ₹1.29 away. Want me to queue an exit?
```

No stale training data. No hallucinated prices. Every answer grounded in what's actually happening right now.

---

## Write a strategy once. Run it forever.

Describe your thesis in plain English. The agent shapes it into a **Playbook** — entry rules, exit criteria, capital allocation, guardrails — and from that point, every decision it makes is anchored to that document.

```
you:   Intraday momentum strategy, long and short. Three concurrent
       positions across Nifty 100 stocks. ₹9,000 deployed. No new
       entries after 2:30pm. Honour my stop-losses.

agent: Here's what I've drafted as "Aggressive Alpha":
       [Playbook document — entry signals, position sizing, SL/target
        rules, EOD close logic, capital per slot]
       Ready to activate?
```

Same rules. Every session. No drift, no forgotten instructions, consistent P&L tracking against the thesis.

---

## The agent builds its own automation stack

When a position opens, the agent immediately registers the full set of triggers to manage it — stop-losses, targets, trailing stops, monitors, re-entry scanners. You describe the risk model once in the Playbook. The agent wires it up.

```
Aggressive Alpha — triggers registered after opening 3 positions:

  ✓ HINDALCO SL          hard_order  BUY MARKET    price ≥ ₹964
  ✓ HINDALCO Target      hard_order  BUY MARKET    price ≤ ₹948
  ✓ HINDALCO Trail       reasoning   move SL       price ≤ ₹938
  ✓ ONGC SL              hard_order  BUY MARKET    price ≥ ₹273.04
  ✓ Nifty Drop Guard     reasoning   review longs  nifty_drop ≥ 1%
  ✓ Correlated Drawdown  reasoning   review all    2+ positions > −0.75%
  ✓ Position Monitor     reasoning   VWAP + RSI    every 30 min
  ✓ EOD Hard Close       reasoning   close all     15:10 daily
```

---

## Always watching. Only thinking when it matters.

**Heartbeat** monitors your positions and triggers every 30 seconds — without running the LLM. Price conditions are evaluated in pure JavaScript. Cron handles time-based triggers. The expensive model only wakes up when something actually fires.

```
09:00  ──  tick  3 positions · 10 triggers evaluated  →  0 fired
09:30  ──  tick  Position Monitor fired  →  reasoning_job started
09:31  ──  agent queued 2 approval(s)
10:00  ──  tick  3 positions · 10 triggers evaluated  →  0 fired
10:30  ──  tick  Position Monitor fired  →  reasoning_job started
10:31  ──  agent queued 2 approval(s)
15:10  ──  EOD Hard Close fired  →  all positions squared off
```

---

## Nothing happens without your say-so

Before any order is placed, the agent submits a structured approval card — not a chat message. The exact trade, and every signal that led to the recommendation. You approve or reject. The gate is code-level; there is no way around it.

```
  APPROVAL REQUEST · Aggressive Alpha — Position Monitor
  ────────────────────────────────────────────────────────
  SELL · ONGC · 11 shares · MARKET ORDER · Close SHORT
  Entry ₹269.00   LTP ₹271.75   Unrealised −₹30.25

  🔴 3 EXIT SIGNALS FIRED

  SIGNAL 1 — RSI DETERIORATION
  RSI risen to 56.52, crossing the 55 ceiling for short momentum.
  Buyers are stepping in. Downside thesis is losing steam.

  SIGNAL 2 — HIGH-VOLUME RECOVERY
  Last two candles (179K, 260K vol) show price bouncing off lows.
  A short needs sellers in control. This shows the opposite.

  SIGNAL 3 — POST-1PM LOSS, NO CATALYST
  13:30 IST. Down −1.02% with hard SL only ₹1.29 away. Holding
  risks the full −1.5% loss; exiting now saves ~₹5.30/share.

  [ ✓ Approve ]  [ ✗ Reject ]
```

Three consent modes — **in-chat** (you're present), **async** (agent queues while you're away), **autonomous** (within guardrails you define upfront in the Playbook).

---

## Every decision on record. Permanently.

Every trade is written to an immutable journal with the agent's reasoning at the moment of decision — not a post-hoc summary. Every trigger run is logged, including runs where no trade was placed. Ask the agent to explain any past decision and it has the full context.

```json
{
  "symbol": "ONGC",
  "transactionType": "SELL",
  "quantity": 11,
  "executedPrice": 269.00,
  "note": "Slot B SHORT. Below VWAP all session, RSI 45 falling,
           MACD negative, weak oil sector on bearish day.
           SL: ₹273.04 · Target: ₹262.28",
  "filledAt": "2026-03-11 10:19:12"
}
```

---

## How it works

Vibe Trade is built on six primitives. Each one solves a problem an LLM can't solve on its own.

```
Heartbeat → snapshot → Trigger fires → Playbook loaded
  → LLM reasons → Permissions gate → Trade placed → Learnings logs
```

| # | Primitive | What it gives the agent |
|---|-----------|------------------------|
| 01 | **Market Tooling** | 20 tools — live quotes, candles, indicators, fundamentals, news, order book, broker execution |
| 02 | **Heartbeat** | 30s monitoring loop — evaluates all trigger conditions without running the LLM |
| 03 | **Triggers** | Condition + action. Modes: `code` `event` `time` `llm`. Types: `hard_order` `reasoning_job` |
| 04 | **Permissions** | Code-level approval gate — three consent modes, full audit trail |
| 05 | **Playbooks** | Persistent strategy document — consistent identity, isolated P&L, capital bounds |
| 06 | **Learnings** | Immutable trade journal — reasoning captured at decision time, not reconstructed after |
| 07 | **Skills** | Reusable instruction modules per Playbook _(coming soon)_ |

→ [Full documentation](https://vibetrade-ai.github.io/docs)

---

## Quickstart

**Requirements**

| Dependency | |
|------------|--|
| Node.js ≥ 20 | Runtime |
| Anthropic API key | Claude Sonnet for reasoning jobs, Haiku for condition evaluation |
| Dhan account | Broker — credentials added at `/settings` |

Vibe Trade is designed to support multiple brokers. We're starting with **Dhan** — more brokers are on the roadmap.

Add your Anthropic API key and Dhan credentials at `http://localhost:3001/settings` once the server is running.

Everything runs on your machine. Your API key, credentials, trade history, and Playbooks never leave your local environment — stored in `~/.vibetrade/`.

> **Start with chat before automation.** Ask the agent to look at your positions, fetch a quote, explain a stock's technicals. Once you're comfortable with how it reasons and what tools it has, give it a Playbook and let it run.

---

## Built with

Next.js 15 · React 19 · Claude (Anthropic) · Dhan Broker API · Node.js · TypeScript

---

## Roadmap

- [x] Market Tooling — 20 built-in tools, Dhan broker
- [x] Heartbeat — 30s monitoring loop
- [x] Triggers — `code`, `event`, `time`, `llm` conditions
- [x] Permissions — in-chat and autonomous consent
- [x] Playbooks — persistent strategy documents
- [x] Learnings — immutable trade journal
- [ ] Skills — reusable markdown files that teach the agent a technique
- [ ] Async approvals — WhatsApp / Telegram
- [ ] Additional brokers
- [ ] Hosted mode — always-on Heartbeat

---

## Docs

**[vibetrade-ai.github.io/docs](https://vibetrade-ai.github.io/docs)**

---

## Talk to the founders

Have a strategy in mind? Want to run us through your setup? We're happy to jump on a call.

**[Book a 30-minute call →](https://calendly.com/sahil-revise/30min-meeting)**

---

