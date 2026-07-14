import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./mocks/routes";

const BASE = "http://localhost:5173/bsky-chat-mapper/";

test.describe("Bluesky Chat Mapper", () => {
  test.describe.configure({ mode: "serial" });

  // -----------------------------------------------------------------------
  // Login flow
  // -----------------------------------------------------------------------
  test("renders login page", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator("h1")).toHaveText("Bluesky Chat Mapper");
    await expect(page.locator("input[placeholder*='alice']")).toBeVisible();
    await expect(page.locator("input[placeholder*='password']")).toBeVisible();
    await expect(page.locator("button:has-text('Sign in')")).toBeVisible();
  });

  test("login with mock API and shows convo picker", async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto(BASE);

    // Fill credentials
    await page.fill("input[placeholder*='alice']", "alice.bsky.social");
    await page.fill("input[placeholder*='password']", "hunter2");
    await page.click("button:has-text('Sign in')");

    // Should show convo list
    const convos = page.locator(".convo-item");
    await expect(convos).toHaveCount(3, { timeout: 10000 });
    await expect(convos.first()).toContainText("Test Chat Squad");
  });

  // -----------------------------------------------------------------------
  // Full pipeline: select convo → Start → graph renders
  // -----------------------------------------------------------------------
  test("full pipeline renders graph after processing", async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto(BASE);

    // Login
    await page.fill("input[placeholder*='alice']", "alice.bsky.social");
    await page.fill("input[placeholder*='password']", "hunter2");
    await page.click("button:has-text('Sign in')");

    // Wait for convo picker
    const convos = page.locator(".convo-item");
    await expect(convos.first()).toBeVisible({ timeout: 10000 });

    // Click first convo
    await convos.first().click();

    // Should see the processing steps area with a Start or Generate Map button
    // Select "All time" to avoid date-offset issues with mock data
    await page.selectOption('select, [role="combobox"]', "all");
    const startBtn = page.locator("button:has-text('Start')");
    await expect(startBtn).toBeVisible();
    await startBtn.click();

    // Wait for graph to render — cluster nodes should appear
    // Processing takes time (embedding + clustering). Use a generous timeout.
    // After clustering, click "Generate Map" to enter graph view
    const genMapBtn = page.locator("button:has-text('Generate Map')");
    await expect(genMapBtn).toBeVisible({ timeout: 60000 });
    await genMapBtn.click();

    const clusterNodes = page.locator(".graph-svg g circle");
    await expect(clusterNodes.first()).toBeVisible({ timeout: 30000 });
    const count = await clusterNodes.count();
    expect(count).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Graph interactions
  // -----------------------------------------------------------------------
  test("clicking a cluster node shows sidebar messages", async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto(BASE);

    // Login and go through pipeline
    await page.fill("input[placeholder*='alice']", "alice.bsky.social");
    await page.fill("input[placeholder*='password']", "hunter2");
    await page.click("button:has-text('Sign in')");
    await expect(page.locator(".convo-item").first()).toBeVisible({ timeout: 10000 });
    await page.locator(".convo-item").first().click();
    await page.selectOption('select, [role="combobox"]', "all");
    await page.locator("button:has-text('Start')").click();

    // Wait for graph
    const genMapBtn2 = page.locator("button:has-text('Generate Map')");
    await expect(genMapBtn2).toBeVisible({ timeout: 60000 });
    await genMapBtn2.click();
    await expect(page.locator(".graph-svg g circle").first()).toBeVisible({ timeout: 30000 });

    // Click a cluster node
    await page.locator(".graph-svg g circle").first().click({ force: true });

    // Sidebar should appear with messages
    const sidebar = page.locator(".graph-sidebar");
    await expect(sidebar).toBeVisible({ timeout: 5000 });
    await expect(sidebar.locator(".sidebar-msg")).not.toHaveCount(0);
  });

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------
  test("fuzzy search in graph finds matches", async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto(BASE);

    // Login and go through pipeline
    await page.fill("input[placeholder*='alice']", "alice.bsky.social");
    await page.fill("input[placeholder*='password']", "hunter2");
    await page.click("button:has-text('Sign in')");
    await expect(page.locator(".convo-item").first()).toBeVisible({ timeout: 10000 });
    await page.locator(".convo-item").first().click();
    await page.selectOption('select, [role="combobox"]', "all");
    await page.locator("button:has-text('Start')").click();

    // Wait for pipeline to complete
    const genMapBtn2 = page.locator("button:has-text('Generate Map')");
    await expect(genMapBtn2).toBeVisible({ timeout: 60000 });
    await genMapBtn2.click();
    await expect(page.locator(".graph-svg g circle").first()).toBeVisible({ timeout: 30000 });

    // Switch to Fuzzy mode for simpler test
    await page.locator('label:has-text("Fuzzy")').click();

    // Type search query
    const searchInput = page.locator('input[placeholder="Search clusters..."]');
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await searchInput.fill("Tokyo");
    await page.click("button:has-text('Search')");

    // Should show search results in sidebar
    const sidebarMeta = page.locator(".sidebar-meta");
    await expect(sidebarMeta).toBeVisible({ timeout: 10000 });
    await expect(sidebarMeta).toContainText("match");
  });

  // -----------------------------------------------------------------------
  // Logout
  // -----------------------------------------------------------------------
  test("logout clears session and returns to login", async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto(BASE);

    // Login
    await page.fill("input[placeholder*='alice']", "alice.bsky.social");
    await page.fill("input[placeholder*='password']", "hunter2");
    await page.click("button:has-text('Sign in')");
    await expect(page.locator(".convo-item").first()).toBeVisible({ timeout: 10000 });

    // Find and click logout
    const logoutBtn = page.locator("button:has-text('Log out')");
    if (await logoutBtn.isVisible()) {
      await logoutBtn.click();
    }

    // Should be back on login page
    await expect(page.locator("h1")).toHaveText("Bluesky Chat Mapper", { timeout: 5000 });
    await expect(page.locator("input[placeholder*='alice']")).toBeVisible();
  });
});
