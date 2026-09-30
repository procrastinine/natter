# Some motivation

There are some relatively specific features that I could not get from other frontends, so I decided to build my own because it's easy with agents now anyways. Some gripes:
- Privacy: yes, API LLMs are not the most private things in the world, but some things are more not-private than others. I use OpenRouter because it's about as private as you can get for large or frontier models: there is a large user base that your prompts are mixed with, you can see what data retention different providers have and control it granularly, you can pay for it with crypto that needs no real name or address, and there is also just the convenience that you can access pretty much any current LLM you want with a single key. The specific thing I wanted to solve in this regard is that I couldn't find a frontend that scraped live data from OpenRouter to show exactly what providers had what amount of privacy, and then easily choose a custom list.
- API parameters: similarly, many frontends expose some blanket list of parameters, which may or may not be complete, and also may or may not apply for any specific model and provider. For example: for caching Claude models, I could find _no_ frontend that had an easy GUI option for the breakpoint and TTL option; and for many frontends, what specific sampling parameters are supported on what specific model are just "haha, pass it in". For natter on OpenRouter specifically, there is a per-provider discovery of exactly what parameters (or context lengths, or whatever) are supported, and the UI dynamically updates to show only those. It also supports prefill which I have really not seen other UIs do...
- The interface itself (browser): browsers are so nice in terms of navigation. You can use different tabs, URLs, the back button, clicking on links in new tabs, etc etc etc, but I have not seen _any_ frontend, even browser ones, really take advantage of this. So natter has a full URL for every chat, branch, attachment, etc, you can use the back button or middle click on basically anything, you can view the same chat on different tabs to copy and paste and whatever, you basically have the full freedom of the browser. Furthermore, needing a server to host literal javascript calls is completely unnecessary, so natter needs no server at all and can just be run through e.g. GitHub pages or any static file, with everything saved in IndexedDB. For any remote users, this means that no data is sent other than for required LLM API calls.
- Context and editability: okay I actually never super liked the "chat" model. In an ideal world, I would have liked to build a frontend for text completions as just a canvas of text with breakpoints you can edit context in, but I have found very few base models hosted anywhere (e.g. DeepSeek v4 Pro base exists, but no one hosts it because it's not economically viable and now it's just AGENTS AGENTS AGENTS RL'd to hell with responses). But regardless, the purpose of natter is to play with raw context and responses, so you can edit absolutely anything, you can edit messages and responses in place, you can edit reasoning, you can edit the message tree, you can pretend you sent a message and an LLM responded, you just get full editability and context control. I see it almost as a "context control IDE" except that the chat format is what every API uses so I am forced into adopting it.
- Maybe as a futile last resistance against the chat format, at the very least, I am not going to use stupid chat bubbles. Text is properly displayed with a proper centering and a proper width so you can actually read it, and you can collapse it from any point by clicking the icon that follows you from the left; you can also hide all UI elements by clicking a focus mode button. I wanted it so that it would be a pleasant experience even if you were reading a novel on this.

# Therefore, what I implemented

- SPA with IndexedDB
- Browser-native navigation
- Full control of both API parameters and context, with presets you can save
- Lots of edit tools for messages, reasoning, and a tree view
- Compatibility with most things (arbitrary OpenAI-compatible chat completions API, OpenAI Responses API, Anthropic Messages API, Gemini native API), including switching between them, including preserving reasoning between them
- Standard features like attachments, folders, tags, search, export, context estimation, etc
- **It is a playground! Do not expect agentic stuff (even though it supports provider tools), this is for testing and having fun with raw model inputs/outputs**

# Local development

Inter 4.1 and Source Serif 4.005 are bundled. Their SIL Open Font licenses are in
`public/fonts/`. Both families are served by Natter itself, with no external font
service or installed-font lookup. Inter is the default; Serif is available in Appearance.

| script | purpose |
|---|---|
| `pnpm dev` | Vite dev server |
| `pnpm build` | checked production bundle in `dist/` with type and distribution-policy gates |
| `pnpm preview` | serve the built bundle locally |
| `pnpm fake-provider` | standalone loopback LLM API server with bounded generated and scripted streaming scenarios |
| `pnpm test` | Vitest in watch mode |
| `pnpm test:run` | Vitest single run |
| `pnpm verify:ci` | the same complete verification entrypoint as GitHub, using an immutable source snapshot |
| `pnpm verify:slice:plan -- --begin --head` | capture the current commit as the comparison baseline before a change |
| `pnpm verify:slice:plan -- --baseline <id>` | derive affected checks and seal a candidate after the change |
| `pnpm verify:slice -- --baseline <id> --candidate <candidate-id>` | execute the planned candidate with all affected browser projects and one application build |
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
| `pnpm perf:delivery <dev\|preview> <url>` | fresh-browser delivery report; preview compares request/byte ratchets, while both modes reject diagnostics and forbidden cold-loads |
| `pnpm perf:report` | machine-readable distribution, named lazy-chunk, duplication, and dependency-cycle report; records delivery-ratchet overruns and fails on hard topology/cycle/stream boundaries |
| `pnpm format` | Biome format (write) |
| `pnpm check` | Biome lint + format + organize imports |

Playwright and affected-test selection share project ownership in
`scripts/playwright-projects.mjs`; unit project membership lives in `scripts/vitest-projects.mjs`.
Verification checks unit and browser receipts for missing files, unexecuted tests and retries;
a successful process alone is insufficient. Declared skips are separate from executed cases.
Ordinary tooling edits follow their dependencies; shared runtime/configuration changes retain full coverage.
The full and affected runners share stage commands, prerequisite ordering, environment and result
checks. A selected consumer brings its required producer; a failed prerequisite prevents dependent
work while independent checks continue. Unit and browser setup changes invalidate their own runners.
Browser phases run sequentially against one build, so performance measurements stay isolated
without an earlier independent failure suppressing later coverage. Only actual setup dependencies
require predecessor success.
Pure tooling tests use a Node project without loading the browser application. Tests with browser,
application, or unresolved dependencies retain the jsdom setup; both projects share one test run.
One sequencer prioritizes failures and expensive files across both projects, sharing two isolated workers.
Logs and receipts remain under `test-results/`. Open architectural obligations are reported
separately and keep a slice from claiming full closure even when its selected checks pass.

Ordinary Send helpers wait for the enabled submit control. Tests of input during preparation
or streaming issue raw gestures and assert their outcomes. Use the fake provider's explicit
hold/release controls to exercise those transitions; visible reply text does not mean the
stream has finished.

Native storage fixtures in browser tests and profiles use one operation owner. It binds the active
database and activation sequence under a physical slot lease, owns request failures and transaction completion,
and closes handles before releasing ownership. Use indexed queries for chat-specific assertions;
an observed database name alone does not authorize a later operation.

# Technologies, which I am sure are going to suffer from supply chain attacks. Therefore I do all my development on a VPS and publish to GitHub pages so this crap doesn't touch my computer

Node 24+ · React 19 · Vite 8 · TypeScript 7 native compiler (TypeScript 6 compatibility API for semantic tooling) · Tailwind v4 · Dexie (IndexedDB) · Zustand · TanStack Virtual · hand-rolled `fetch` + SSE · Biome · Vitest · Playwright
