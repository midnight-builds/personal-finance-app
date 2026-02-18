# Vision

Finance-app is a **single-user, no-auth** personal finance tracker you run locally (or on your home server).

Core promise: **easy import → automatic categorization → clear reports**, powered by an **Analysis Copilot**.

## AI is core

The **Analysis Copilot (AI)** is a *requirement* and the differentiator of this app.
Without AI, the app still starts and lets you browse/edit data, but it is intentionally limited to **static browsing + manual edits**.

## Product goals

### 1) Easy import
- One-click CSV/XLSX import (start with Nordea).
- Import is **idempotent** and explainable (overlap detection, logs).

### 2) Automatic categorization (AI-first, rule-backed)
- AI suggests categories with reasons, using your existing taxonomy.
- Deterministic rules/heuristics provide baseline + fallback.
- User decisions are remembered and turned into rules.

### 3) Clear reports
- Dashboard: balances, net flow, runway, monthly overview.
- Transfers excluded by default; always drill-down to evidence.

### 4) Analysis Copilot tools
Copilot must have explicit tools for:
- querying transactions and aggregates
- explaining spikes/deltas with evidence
- proposing category rules and data cleanup steps (user confirms)
- running small simulations (runway / what-if)

## Model strategy
- Prefer **newest/highest-quality models** for user-facing reasoning and Copilot analysis.
- Use smaller/faster models for lightweight tasks (classification, formatting) when quality is sufficient.

## Non-goals (now)
- Multi-user/auth
- Multi-currency
- Bank API sync (file import first)

