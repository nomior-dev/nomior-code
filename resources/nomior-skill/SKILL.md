---
name: nomior-context
description: Retrieval policy for the Nomior context tools (context_search, context_get, context_decisions, context_remember). Use when a question may be answered by project history — meetings, decisions, memory, documents — or when the user states a durable fact worth remembering.
---

# Nomior context retrieval policy

Nomior gives you four MCP tools over the project's context store. Follow this
policy whenever they are available.

## Search before asking

Before asking the user about prior work, decisions, dates, people, or
agreements, run `context_search` with a focused query. Only ask the user when a
search (and one reformulation) came back empty.

## Cite ids

Every claim you take from a result must cite the snippet's `id` inline, e.g.
`(ctx: meeting_2026-08-12_standup)`. Never present retrieved content as your
own knowledge, and never cite an id you did not receive from a tool result.

## Fetch full documents only after a search

`context_get` is a drill-down, not a browser. Call it only with an `id` a
`context_search` returned in this session, and only when the snippet is not
enough. Prefer another, narrower search over expanding long sources.

## Respect scope

Results are scoped to one Nomior project. Do not try to widen scope to answer
faster, do not retry a scope-refused call with invented scope ids, and do not
mix content across scopes in one answer. If no scope resolves, tell the user to
pick the project instead of guessing.

## Respect the budget

Truncated results tell you how to narrow the query — follow that guidance
rather than raising `budget_tokens`. Small, precise queries beat large dumps.

## Remembering

When the user states a durable fact, preference, or decision, propose it with
`context_remember` in the current scope. It creates a pending candidate only:
the user approves it in Nomior. Do not claim it was saved as memory; say it was
proposed.

## Decisions and tasks

For "what did we decide" or "what is open" questions, prefer
`context_decisions` over free-text search — it returns structured decisions and
tasks with evidence ids you can cite.
