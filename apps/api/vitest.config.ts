import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    deps: {
      external: ['node:sqlite'],
    },
  },
  resolve: {
    alias: {
      sqlite: 'node:sqlite',
    },
  },
});
