import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['ui/src/ui/controllers/session-hygiene.test.ts'],
    environment: 'node',
    globals: true,
    watch: false,
  },
});
