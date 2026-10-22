import { defineConfig } from 'vitest/config';

// This pure payload boundary needs no browser, SWC transform, or live service.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/lib/settingsSave.test.ts'],
  },
});
