import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'ui/src/ui/controllers/session-hygiene.test.ts',
      'ui/src/ui/app-render.helpers.node.test.ts',
    ],
    environment: 'happy-dom',
    globals: true,
    watch: false,
  },
});
