import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Edge vendor keeps the Deno pin; tests resolve that exact specifier to the installed zod package.
  resolve: { alias: { 'npm:zod@3.23.8': 'zod' } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
