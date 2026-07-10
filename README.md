# natter

A browser-only chat UI for OpenAI-compatible LLM APIs. OpenRouter-first; also talks to OpenAI direct, Gemini native, Anthropic via the OpenAI-compat shim, generic OpenAI-compatible endpoints, and `llama-server`.

The whole app is a static bundle, served from any file server or opened directly from `file://`. Keys, chats, attachments, and settings live in IndexedDB in the browser. Multiple tabs against the same workspace are coordinated via Web Locks and BroadcastChannel, so concurrent writes don't conflict.

## Why this exists

The goal is an easy way to use a variety of models on OpenRouter while keeping things at least reasonably private (anonymized/no user ID retention, no prompt retention in policy). Additional gaps in other frontends were reasoning support (including encrypted reasoning), proper caching for different models, and various testing/copy-pasting mechanisms that benefit a lot from having a fully-featured chat tree, in-place editing, prefill, etc etc.

## OpenRouter privacy

Different providers behind the same OpenRouter model have different data-retention terms, and the JSON `/endpoints` API doesn't expose them; they have to be scraped from the per-model providers page. natter does that scrape (cached 24h) and uses the labels to filter and rank endpoints. Endpoints that are strictly less private than another option for the same model are removed entirely (Pareto-dominance, not just deprioritized). Models that allow training on prompts are blocked. Free models opt out, since otherwise nothing would be eligible. The provider picker also has manual pin/block controls and a preferred-order list, and the chat header shows the resulting tier.

## Model controls

natter discovers which parameters a given model+endpoint actually supports and only surfaces those. Per-model quirks the wire APIs don't advertise are also handled: sampling gates on the GPT-5.4 family, cache-token thresholds on Anthropic, models that require the Responses API, models with adaptive-only reasoning, OSS models that emit `<think>` tags inline.

## Reasoning

Different providers return reasoning in different shapes, and dropping the shape-specific metadata silently breaks multi-turn reasoning on most current models. natter preserves the `phase` markers OpenAI's Responses API needs (without them, gpt-5.3-codex / 5.4 / 5.4-pro stop generating early), the encrypted reasoning blocks that only round-trip through `/v1/responses`, Gemini's `thoughtSignature` (which only survives via the native Gemini API, not the OpenAI shim), and the inline `<think>` tags from OSS models like DeepSeek-R1, Qwen3, and Gemma. Reasoning content is editable per-detail, and per-carrier toggles (text/summary/encrypted) control what gets carried forward.

## Context, cost, caching

A token estimator calibrates from observed usage, with fallbacks from per-chat to workspace-wide, then to a model-family anchor, then to a generic ratio. The current estimate is shown per message, per turn, and per attachment. Context cutoff is explicit, with a prompt-size readout (no silent truncation).

Cache breakpoint controls cover Anthropic (TTL plus off/auto/manual), Gemini (manual), and OpenAI (implicit), and each provider's minimum-tokens threshold is enforced (so e.g. the Anthropic cache UI doesn't pretend to do anything below the relevant 1024/2048/4096 boundary). Per-message cost is broken out by prompt, completion, reasoning, cache-read, cache-write, audio, and video.

## Message tree, editing, prefill

Any message can be edited in place, keeping the same id, with no new sibling and no API call. Any message can also be branched via regenerate, continue, or insert-sibling, or used as the fork point for a whole new chat. Messages can be inserted between existing ones, and the four delete variants cover single-message, message-pair, whole-turn, and just-this-variant cases. The assistant can be prefilled with arbitrary opening text before sending. A branch tree view (with search and jump-to-latest) makes navigating dense trees workable. Switching between branches moves a cursor; no rows are duplicated.

## Browser-native navigation

Every chat, branch, attachment, and storage view has its own URL. Reload restores the chat and the active branch. Sidebar entries, branch arrows, branch tree nodes, storage rows, and attachment chips are `<a>` anchors, so middle-click and Cmd-click work everywhere, including (deliberately) on the branch arrows, so a swipe-variant can be opened in a new tab.

## Other things

Image, PDF, audio, and video attachments with per-modality token estimation. Folders, tags, and full-text search in the sidebar. Flatten-export of a chat to text. JSON-schema response format. Tool calling with manual execution, plus OpenRouter's server-side tools. Workspace-global prompt presets for system/continue-system/continue-user slots. 5-second undo window on structural ops. Focus mode.

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
| `pnpm e2e` | Playwright end-to-end suite |
| `pnpm typecheck` | `tsc -b --noEmit` across all projects |
| `pnpm lint` | Biome lint |
| `pnpm deps:refresh` | update dependencies with pnpm supply-chain guards, then print audit/outdated/build-script info |
| `pnpm deps:refresh -- --check` | print the same dependency info without updating |
| `pnpm deps:audit` | npm advisory audit at `moderate` and above |
| `pnpm deps:outdated` | list dependency updates visible under the current pnpm policy |
| `pnpm format` | Biome format (write) |
| `pnpm check` | Biome lint + format + organize imports |

## Stack

React 19 · Vite 8 · TypeScript 6 · Tailwind v4 · Dexie (IndexedDB) · Zustand · TanStack Query · TanStack Virtual · hand-rolled `fetch` + SSE · Biome · Vitest · Playwright
