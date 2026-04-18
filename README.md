# natter

A browser-only chat UI for LLM APIs. Bring a key, open a tab, have a natter.

No server. No account. No subscription. No agents.

## What it is

A static SPA — nothing to deploy, nothing to sign into. All state lives in your browser
(IndexedDB). Runs against any OpenAI-compatible endpoint: OpenRouter (primary target),
OpenAI direct, Anthropic, Gemini, or a custom base URL.

## What makes it different

- **Branch anywhere.** Every message is a branch point. Swipe through variants at any depth —
  not just the last reply.
- **Edit in place.** Fix a typo or rephrase any message (yours, the model's, the system
  prompt) without forcing a regenerate. Descendants stay put.
- **Private by default.** When a strictly more private endpoint exists for the same model, the
  less private one is excluded — not just deprioritized. Pareto-dominance filter over
  OpenRouter provider metadata. Relaxes automatically for `:free` models.
- **Live capability discovery.** Parameter controls only render for things the currently
  selected provider actually accepts. Pulled from `/api/v1/models/{id}/endpoints` per request;
  no stale tables lying about what works.
- **Reasoning, first-class.** All three OpenRouter variants (text / summary / encrypted) are
  stored and round-tripped structurally. Responses API is the default for OpenAI so encrypted
  reasoning survives across turns.
- **Multi-tab safe.** Open the same chat in ten tabs. Edits, streams, and branching all
  converge via BroadcastChannel + Web Locks.

## What it isn't

- Not agentic. No tool-using autonomous loops, no background tasks, no sub-agents.
- Not a hosted service. You run it locally or on any static host.
- Not account-based. No sign-in. Bring your own key.
- Not a mobile-first layout. Works on phones; not optimized for them.

## Quickstart

```sh
pnpm install
pnpm dev
```

Open the printed URL, paste your key, start chatting.

## Scripts

| script | what |
|---|---|
| `pnpm dev` | Vite dev server at `:5173` |
| `pnpm build` | Production static bundle (`dist/`) |
| `pnpm preview` | Serve the built bundle locally |
| `pnpm test` | Vitest in watch mode |
| `pnpm test:run` | Vitest single run |
| `pnpm typecheck` | `tsc --noEmit` across all projects |
| `pnpm lint` | Biome lint |
| `pnpm format` | Biome format (write) |
| `pnpm check` | Biome lint + format + organize imports |

## Stack

React 19 · Vite 8 · TypeScript 6 (strict, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`) · Tailwind v4 · Dexie (IndexedDB) · Zustand · TanStack Query ·
TanStack Virtual · hand-rolled `fetch` + SSE streaming · Biome · Vitest.

## Status

Scaffold only. Nothing is wired yet. See `../plan/` for the full implementation plan
(phased delivery in `../plan/13-delivery.md`).
