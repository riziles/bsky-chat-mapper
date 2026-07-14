import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  timeout: 120000,  // 2 min per test (embedding takes time)
  retries: 0,
  use: {
    baseURL: "http://localhost:5173",
    headless: false,  // Ternlight WASM may need a real browser
    viewport: { width: 1280, height: 800 },
    actionTimeout: 15000,
  },
});
