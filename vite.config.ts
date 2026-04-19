/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset URLs keep the exported bundle portable across static hosts
  // and subpaths instead of assuming deployment at `/`.
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // `openrouter.ai/{model}/providers` doesn't serve CORS, so a
      // browser-origin fetch is blocked. In dev we proxy it through
      // Vite's own server so `/_or_scrape/*` becomes same-origin and
      // the scrape can read the live HTML. `privacyScrapeUrl` uses
      // `/_or_scrape` as its default base; production builds without a
      // server-side proxy will 404 and the filter falls back to the
      // curated `data_policies.json` table.
      '/_or_scrape': {
        target: 'https://openrouter.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/_or_scrape/, ''),
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: [
      'tests/unit/**/*.{test,spec}.{ts,tsx}',
      'tests/integration/**/*.{test,spec}.{ts,tsx}',
    ],
    globals: false,
    css: false,
    // Node's BroadcastChannel crosses worker_threads within a single process,
    // which makes the default `threads` pool leak cross-tab broadcast events
    // between parallel test files. Forks give each file its own process and
    // keep that leakage out of tests that assert on event fan-out.
    pool: 'forks',
  },
})
