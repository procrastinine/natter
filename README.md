# natter

A browser-only chat UI for LLM APIs. OpenRouter-first; also talks to OpenAI direct, Gemini native, Anthropic's native Messages API, generic OpenAI-compatible endpoints, and `llama-server`. Anthropic and Gemini can use an OpenAI-compatible shim only when a chat explicitly selects that route.

The whole app is a static bundle, served from any file server or opened directly from `file://`. Keys, chats, attachments, and settings live in IndexedDB in the browser. Multiple tabs against the same workspace are coordinated via Web Locks and BroadcastChannel, so concurrent writes don't conflict.

## Why this exists

The goal is an easy way to use a variety of models on OpenRouter while keeping things at least reasonably private (anonymized/no user ID retention, no prompt retention in policy). Additional gaps in other frontends were reasoning support (including encrypted reasoning), proper caching for different models, and various testing/copy-pasting mechanisms that benefit a lot from having a fully-featured chat tree, in-place editing, prefill, etc etc.

## OpenRouter privacy

Different providers behind the same OpenRouter model have different data-retention terms, and the JSON `/endpoints` API doesn't expose them; they have to be scraped from the per-model providers page. natter does that scrape (cached 24h) and uses the labels to filter and rank endpoints. Endpoints that are strictly less private than another option for the same model are removed entirely (Pareto-dominance, not just deprioritized). Models that allow training on prompts are blocked. Free models opt out, since otherwise nothing would be eligible. The provider picker also has manual pin/block controls and a preferred-order list, and the chat header shows the resulting tier.

## Browser key-storage boundary

API keys are encrypted before they are written to IndexedDB. By default, the wrapping secret is stored in the same browser database, which protects against casual at-rest inspection but not against script execution in the page origin. Passphrase-protected keys avoid persisting that wrapping secret, although a decrypted key still exists briefly in the active tab when used. Treat full-workspace exports as sensitive: the current full backup includes both encrypted key rows and the install secret.

For hardened hosted deployments, start with a response-header policy like this and extend `connect-src` and `img-src` only for configured custom endpoints and image origins:

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; connect-src 'self' https://openrouter.ai https://api.openai.com https://api.anthropic.com https://generativelanguage.googleapis.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'
```

This is a deployment template, not a runtime default: arbitrary compatible endpoints, user-approved image origins, workers, and `file://` use need environment-specific treatment.

## Model controls

natter discovers which parameters a given model+endpoint actually supports and only surfaces those. Per-model quirks the wire APIs don't advertise are also handled: sampling gates on the GPT-5.4 family, cache-token thresholds on Anthropic, models that require the Responses API, models with adaptive-only reasoning, OSS models that emit `<think>` tags inline.

## Reasoning

Different providers return reasoning in different shapes, and dropping the shape-specific metadata silently breaks multi-turn reasoning on most current models. natter preserves the `phase` markers OpenAI's Responses API needs (without them, gpt-5.3-codex / 5.4 / 5.4-pro stop generating early), the encrypted reasoning blocks that only round-trip through `/v1/responses`, Gemini's `thoughtSignature` (which only survives via the native Gemini API, not the OpenAI shim), and the inline `<think>` tags from OSS models like DeepSeek-R1, Qwen3, and Gemma. Reasoning content is editable per-detail, and per-carrier toggles (text/summary/encrypted) control what gets carried forward.

## Context, cost, caching

A token estimator calibrates from observed usage, with fallbacks from per-chat to workspace-wide, then to a model-family anchor, then to a generic ratio. The current estimate is shown per message, per turn, and per attachment. Context cutoff is explicit, with a prompt-size readout (no silent truncation).

Cache breakpoint controls cover Anthropic (TTL plus off/auto/manual), Gemini (manual), and OpenAI (implicit), and each provider's minimum-tokens threshold is enforced (so e.g. the Anthropic cache UI doesn't pretend to do anything below the relevant 1024/2048/4096 boundary). Per-message cost is broken out by prompt, completion, reasoning, cache-read, cache-write, audio, and video.

## Message tree, editing, prefill

Any message can be edited in place, keeping the same id, with no new sibling and no API call. Regenerate and insert-sibling create branch variants, while continuing an assistant response appends the returned text to that same stored row. Any message can also be used as the fork point for a whole new chat. Messages can be inserted between existing ones, and the four delete variants cover single-message, message-pair, whole-turn, and just-this-variant cases. The assistant can be prefilled with arbitrary opening text before sending. Branch arrows expose sibling variants directly; switching between them moves a cursor and never duplicates rows. The alternate branch-tree navigator adds in-chat search, connector insertion controls, compact/expanded layouts, and a resizable message inspector without materializing another graph.

## Browser-native navigation

Every chat, branch, attachment, and storage view has its own URL. Reload restores the chat and the active branch. Sidebar entries, branch arrows, branch-tree nodes, storage rows, and attachment chips use real anchors where implemented, so browser-native middle-click and Cmd-click work, including on branch arrows and tree nodes.

## Other things

Image, PDF, audio, and video attachments with per-modality token estimation. Folders, tags, and full-text search in the sidebar. Flatten-export of a chat to text. JSON-schema response format. Provider-hosted tool configuration and persisted tool evidence. General client-side/manual tool execution remains planned. Workspace-global prompt presets for system/continue-system/continue-user slots. 5-second undo window on structural ops. Focus mode.

## Shipped, partial, and planned

| Status | Surface | Evidence |
|---|---|---|
| Shipped | Message-tree swipes, deep links, and in-place editing | `src/ui/chat/BranchControls.tsx`, `src/core/active-path.ts`, `src/core/messages.ts`, `tests/e2e/render-window.spec.ts`, `tests/unit/active-path.test.ts`, `tests/unit/messages.test.ts` |
| Shipped | Native Anthropic Messages and Gemini transports | `src/core/api-choice.ts`, `src/api/anthropic-messages.ts`, `src/api/gemini-native.ts`, `tests/unit/api-choice.test.ts`, `tests/unit/api-anthropic-messages.test.ts`, `tests/unit/api-gemini-native.test.ts` |
| Shipped | Explicit provider-hosted tools and returned tool evidence | `src/core/send-planning.ts`, `tests/e2e/provider-tool-fixture-replay.spec.ts` |
| Partial | Auto-title status schema and persistence | `src/core/types.ts`, `src/store/chats.ts`, `src/store/db.ts`, `tests/unit/db-schema.test.ts`; background title generation is not complete |
| Shipped | Alternate branch-tree navigator | `src/ui/chat/BranchTreeView.tsx`, `src/ui/chat/BranchTreeInspector.tsx`, `src/core/branch-tree-layout.ts`, `tests/e2e/branch-tree.spec.ts`, `tests/unit/branch-tree-view.test.tsx` |
| Planned | Client-side/manual tool execution and approvals | No client-side executor or approval flow is shipped yet |
| Planned | Daemon/SQLite workspace backend | No daemon workspace engine is shipped yet |

## Quickstart

```sh
pnpm install
pnpm dev
```

## Verification

Run `pnpm check:ci` for the clean, non-writing Biome check. The broader source checks are `pnpm typecheck`, `pnpm lint:semantic`, `pnpm test:run`, and `pnpm build`. The checked build rejects unexpected distribution paths and unsafe artifacts, including invalid module-entry topology. `pnpm perf:report` reports delivery ratchets and the zero-dependency-cycle gate; CI treats that performance step as advisory, while wall time and heap measurements remain informational.

GitHub Pages publication is intentionally independent from the quality workflow. Only dependency installation, the production-artifact startup smoke (which builds the Pages artifact), artifact upload, and the Pages deployment itself can block publication. Verification still runs on pull requests and `main`; unit tests plus the exhaustive built-artifact browser suite are correctness gates, while peer, formatting/lint, dead-code, and performance findings are advisory so findings remain visible without holding the published site stale. Playwright starts a standalone loopback fake-provider process for deterministic HTTP/SSE cases; the application contains no fake transport or test stream entry point.

Application behavior uses the same code paths under `pnpm dev` and the built artifact. The one deliberate runtime-default exception is the OpenRouter provider-privacy scrape: Vite development can use its same-origin `/_or_scrape` proxy, while a static production deployment performs no live scrape unless a CORS proxy is configured in Settings. This exception does not affect chat, branch, storage, navigation, or streaming state.

`pnpm dev` is the normal unbundled Vite/HMR environment, so its request count and decoded source are intentionally much larger than the minified application. Use `pnpm preview` when testing production-like delivery weight. With either server running, `pnpm perf:delivery dev <url>` or `pnpm perf:delivery preview <url>` records a fresh Chromium context. Preview enforces production request/byte budgets; dev reports request/byte/time/heap measurements without rewarding bundled modules or disabled development tooling. Both modes fail on runtime/network diagnostics or cold-loading a forbidden lazy feature. The frequently used per-chat settings pane stays in the eager graph; Markdown, tree, global settings, storage, and import chunks must stay out of a cold load. The shared ratchets live in `scripts/performance-baseline.json` so the build, report, and browser measurement do not drift.

## Scripts

| script | purpose |
|---|---|
| `pnpm dev` | Vite dev server |
| `pnpm build` | checked production bundle in `dist/` with type and distribution-policy gates |
| `pnpm build:pages` | artifact-only production bundle used by GitHub Pages |
| `pnpm preview` | serve the built bundle locally |
| `pnpm fake-provider` | standalone loopback LLM API server with bounded generated and scripted streaming scenarios |
| `pnpm test` | Vitest in watch mode |
| `pnpm test:run` | Vitest single run |
| `pnpm e2e` | exhaustive Chromium gate against one freshly built artifact and the standalone fake provider |
| `pnpm e2e:production` | alias for the same built-artifact Chromium gate |
| `pnpm e2e:smoke` | focused Chromium production-artifact smoke, including the production-runtime boundary proof |
| `pnpm typecheck` | native TypeScript 7 `tsc -b --noEmit` across all projects |
| `pnpm lint` | Biome lint |
| `pnpm lint:semantic` | type-aware ESLint checks |
| `pnpm check:ci` | non-writing Biome format/lint/import check used by CI |
| `pnpm deps:refresh` | update dependencies with pnpm supply-chain guards, clear Vite's derived dependency cache, then print audit/outdated/build-script info |
| `pnpm deps:refresh -- --check` | print the same dependency info without updating |
| `pnpm deps:audit` | npm advisory audit at `moderate` and above |
| `pnpm deps:peers` | verify installed peer-dependency compatibility |
| `pnpm deps:outdated` | list dependency updates visible under the current pnpm policy |
| `pnpm perf:stream [url] [regens] [text chars] [reasoning chars] [turns] [reloads]` | headless loopback fake-stream profiler; run the dev server separately |
| `pnpm perf:delivery <dev\|preview> <url>` | fresh-browser delivery report; preview enforces request/byte budgets, while both modes reject diagnostics and forbidden cold-loads |
| `pnpm perf:report` | machine-readable distribution, named lazy-chunk, duplication, and dependency-cycle report; enforces delivery budgets and fails on any current cycle |
| `pnpm format` | Biome format (write) |
| `pnpm check` | Biome lint + format + organize imports |

## Stack

Node 24+ · React 19 · Vite 8 · TypeScript 7 native compiler (TypeScript 6 compatibility API for semantic tooling) · Tailwind v4 · Dexie (IndexedDB) · Zustand · TanStack Virtual · hand-rolled `fetch` + SSE · Biome · Vitest · Playwright
