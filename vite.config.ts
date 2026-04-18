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
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.{test,spec}.{ts,tsx}', 'tests/integration/**/*.{test,spec}.{ts,tsx}'],
    globals: false,
    css: false,
    // Node's BroadcastChannel crosses worker_threads within a single process,
    // which makes the default `threads` pool leak cross-tab broadcast events
    // between parallel test files. Forks give each file its own process and
    // keep that leakage out of tests that assert on event fan-out.
    pool: 'forks',
  },
})
