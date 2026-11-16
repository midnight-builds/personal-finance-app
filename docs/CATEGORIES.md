# Category management

How categories, rules and categorization decisions are managed, by the user in
the web UI and by agents (Hermes) over MCP. Agreed with the user 2026-11-15;
terms in `GLOSSARY.md`, the actor decision in `docs/adr/0001-actor-without-authentication.md`.
Origin: Hermes proposal a56b7cbe ("auditoitu kategoriointityökalu MCP:hen").

## Principles

- **One user, several actors.** No login. Every change records the **actor** the
  client names (`user` for the web UI, `hermes` for MCP), next to the decision's
  **source** (manual, rule, AI). An MCP client is as strong as the user: no
  confirmation by the user is needed.
- **History is never rewritten.** Categorization decisions are append-only; a
  category is **archived**, never deleted; a rule is **disabled**, never deleted.
- **No hard-coded categories.** Special categories are found by **role**
  (`fallback`, `income`, `refund`), never by name; the built-in keyword heuristics
  are ordinary rules in the database. Renaming any category keeps it working.
- **Manual beats rule.** A rule never overrides a manual decision, neither on
  import nor when a rule is applied to history. A newer manual decision overrides
  anything.
- **Every change is a change set**: planned (dry run) first, applied with the plan's
  token, undoable as a whole. Money is out of reach: no operation touches amounts,
  dates, accounts, counterparties, balances, transfers or imports.

## Data model changes

- `categories`: `role` (unique, nullable: `fallback` | `income` | `refund`),
  `archived_at`, `merged_into_id`. Archived categories are left out of lists and
  pickers by default but keep their decisions.
- `category_rules`: `match_type` (`contains` | `regex`; regex only for built-in
  rules), `match_field` gains `text` (counterparty + description), `amount_sign`
  (`positive` | `negative` | null), `builtin` flag, `disabled_at`, `actor`,
  `change_set_id`. Priority: user rules above built-in rules.
- `categorization_decisions`: `actor` (null = before actors existed, shown as
  `system`), `reason`, `change_set_id`. `source` stays: `user` = manual,
  `rule`, `ai`, plus `category_archived` and `undo`.
- `change_sets`: id, created_at, actor, kind, reason, plan token, payload (what
  changed, with before values for undo), status (`applied` | `undone`),
  `undo_of_id`.
- Seeding: default categories are created only into an empty table (a renamed
  default is not re-created); role categories are ensured by role.

## Operations (one service, used by REST and MCP)

Each operation is planned and applied the same way: `plan(op)` returns the
changes (rows `from → to`, categories and rules touched, exceptions) and a **plan
token**, a hash of the operation and the current state of everything it touches;
`apply(op, token)` re-plans, refuses with 409 `plan_stale` if the token no longer
matches, and is idempotent (applying the same token twice returns the same change
set).

| Operation | Effect |
|---|---|
| `recategorize` | Explicit transaction ids (≤ 500) → one category, as manual decisions. Never by free-text search. Creates no rules. |
| `create_category` | New category. |
| `rename_category` | New name; id, role, decisions and rules unchanged. |
| `archive_category` | Current transactions move to a chosen category (default: fallback) as new decisions; its rules are disabled. Role categories cannot be archived. |
| `merge_categories` | A → B: like archiving A into B, and A's rules are re-created for B. |
| `create_rule` | Pattern + field + category. Also recategorizes existing matches whose latest decision is not manual; manual matches are listed as exceptions. |
| `disable_rule` | Rule stops matching; history unchanged. |
| `undo` | Reverts a change set with new decisions/states. A row changed again after the set is left as is and reported. An undo cannot be undone. |

Existing REST endpoints keep their shapes and go through the service:
`DELETE /categories/:id` archives (into fallback), `POST /transactions/:id/category`
is a one-row manual recategorization (and keeps its current rule learning in the
UI for now). The actor comes from the `X-Finance-Actor` header (default `user`).

## Delivery

1. **Foundation** — roles, built-in rules in the DB, seeding fix, archive instead
   of delete, actor/reason on decisions, actor header; `GET /categories` adds
   `role` (UI protects role categories by role, not name).
2. **Change sets** — plan/apply/undo service and REST endpoints; existing category
   endpoints record change sets.
3. **MCP tools** — plan, apply, list/show change sets, undo; the MCP client sends
   its actor. A change-log view with undo in the web UI comes later.
