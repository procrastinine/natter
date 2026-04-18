# natter

A browser-first chat UI for OpenAI-compatible APIs.

## What makes it different

- **Can be statically hosted.** It builds to plain HTML/CSS/JS with no required server.
- **Multi-tab friendly.** Persisted mutations are scoped narrowly instead of using a
  coarse whole-chat lock.
- **Branch anywhere.** Every message can fork.
- **Edit in place.** Edits keep the same message identity instead of creating a new node.
- **Dense chat-first UI.** The layout prioritizes conversation density over large bubble
  chrome.
- **Privacy-aware defaults.** Provider/model selection prefers more private endpoints
  when the metadata supports that choice.
- **Live capability discovery.** Controls are driven by endpoint/model metadata rather
  than large hardcoded parameter tables.

## Current architecture

- Static SPA built with Vite
- Browser-local workspace storage in `IndexedDB`
- Scoped multi-tab mutation coordination
- OpenRouter-first, with support for other OpenAI-compatible endpoints

## Quickstart

```sh
pnpm install
pnpm dev
```

## Scripts

| script | purpose |
|---|---|
| `pnpm dev` | Vite dev server |
| `pnpm build` | production static bundle in `dist/` |
| `pnpm preview` | serve the built bundle locally |
| `pnpm test` | Vitest in watch mode |
| `pnpm test:run` | Vitest single run |
| `pnpm typecheck` | `tsc --noEmit` across all projects |
| `pnpm lint` | Biome lint |
| `pnpm format` | Biome format (write) |
| `pnpm check` | Biome lint + format + organize imports |

## Stack

React 19 · Vite 8 · TypeScript 6 (strict, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`) · Tailwind v4 · Dexie (IndexedDB) · Zustand · TanStack
Query · TanStack Virtual · hand-rolled `fetch` + SSE streaming · Biome · Vitest
