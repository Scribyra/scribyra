import { defineConfig } from '@playwright/test';
const port = process.env.SCRIBYRA_TEST_PORT || '4173';
export default defineConfig({
  testDir: './tests/browser', timeout: 600000, expect: { timeout: 60000 }, workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox'] } } },
    { name: 'firefox', use: { browserName: 'firefox', launchOptions: { executablePath: process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH || undefined } } },
    { name: 'webkit', use: { browserName: 'webkit', launchOptions: { executablePath: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH || undefined } } },
  ],
  webServer: { command: `npm run preview -- --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: true, timeout: 30000 },
});
