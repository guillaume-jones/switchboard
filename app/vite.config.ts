import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { switchboard: new URL('./src/switchboard.tsx', import.meta.url).pathname },
    dedupe: ['react', 'react-dom'],
  },
  oxc: { jsx: { runtime: 'automatic' } },
  server: { fs: { allow: ['..'] }, strictPort: true },
  build: { target: 'esnext' },
  clearScreen: false,
})
