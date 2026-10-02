import { defineConfig } from 'tsdown'

// Self-contained build so a `pnpm install` from git (which runs `prepare`)
// produces a working `lib/` without a monorepo checkout or project references.
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: false,
  clean: true,
  outExtensions: () => ({ js: '.js' }),
  deps: {
    // DeepSeek Harness packages are resolved from the host runtime; never bundle them.
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/schemastery',
    ],
  },
})
