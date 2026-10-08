import { defineConfig } from '@playwright/test';

// Run browser regressions against the same compiled UI served to reviewers.
export default defineConfig({
  testDir: './tests',
  workers: 1,
  use: { baseURL: process.env['BASE_URL'] ?? 'http://localhost:8080', headless: true },
});
