/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

function katexWoff2Only() {
  return {
    name: 'natter:katex-woff2-only',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const cleanId = id.split('?', 1)[0] ?? id
      if (!cleanId.endsWith('/katex/dist/katex.css')) return null
      let declarations = 0
      const transformed = code.replace(
        /src:\s*(url\([^)]*\.woff2\)\s*format\(["']woff2["']\))[^;]*;/g,
        (_match, woff2: string) => {
          declarations += 1
          return `src: ${woff2};`
        },
      )
      if (declarations === 0 || /\.woff\)|\.ttf\)/.test(transformed)) {
        throw new Error('KaTeX font declarations changed; refusing to ship unneeded font fallbacks')
      }
      return { code: transformed, map: null }
    },
  }
}

function browserDevtools() {
  return {
    name: 'natter:browser-devtools',
    apply: 'serve' as const,
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: '/tools/browser-devtools.ts' },
          injectTo: 'head' as const,
        },
      ]
    },
  }
}

export default defineConfig(({ command, mode }) => {
  const isViteDevServer = command === 'serve' && mode !== 'test' && !process.env.VITEST
  return {
    // Relative asset URLs keep the exported bundle portable across static hosts
    // and subpaths instead of assuming deployment at `/`.
    base: './',
    plugins: [browserDevtools(), katexWoff2Only(), react(), tailwindcss()],
    server: {
      port: 5173,
      ...(isViteDevServer
        ? {
            watch: {
              ignored: [
                '**/tests/**',
                '**/.playwright-cli/**',
                '**/coverage/**',
                '**/playwright-report/**',
                '**/test-results/**',
              ],
            },
          }
        : {}),
      proxy: {
        // `openrouter.ai/{model}/providers` doesn't serve CORS, so a
        // browser-origin fetch is blocked. In dev the request is proxied
        // through Vite's own server so `/_or_scrape/*` becomes same-origin
        // and the scrape can read the live HTML. Static builds default to no
        // live scrape because this Vite-only route does not exist on GitHub
        // Pages.
        '/_or_scrape': {
          target: 'https://openrouter.ai',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/_or_scrape/, ''),
        },
      },
    },
    build: {
      target: 'es2022',
      sourcemap: false,
    },
    test: {
      environment: 'jsdom',
      environmentOptions: {
        jsdom: {
          url: 'http://localhost/',
        },
      },
      setupFiles: ['./tests/setup.ts'],
      include: [
        'tests/unit/**/*.{test,spec}.{ts,tsx}',
        'tests/integration/**/*.{test,spec}.{ts,tsx}',
        // Phase 11+: `tests/live/**/*.live.test.ts` are gated by `LIVE=1`
        // via `describe.skipIf(!LIVE)`. They're discovered by vitest so
        // callers can pass a single file path, but skipped by default.
        'tests/live/**/*.{test,spec}.{ts,tsx}',
      ],
      globals: false,
      css: false,
      // Node's BroadcastChannel crosses worker_threads within a single process,
      // which makes the default `threads` pool leak cross-tab broadcast events
      // between parallel test files. Forks give each file its own process and
      // keep that leakage out of tests that assert on event fan-out.
      pool: 'forks',
      execArgv: ['--no-experimental-webstorage'],
      maxWorkers: 2,
    },
  }
})
