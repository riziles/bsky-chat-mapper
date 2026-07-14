import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./mocks/routes";

const BASE = "http://localhost:5173/bsky-chat-mapper/";

test.describe("Bluesky Chat Mapper", () => {
  test.describe.configure({ mode: "serial" });

  // -----------------------------------------------------------------------
  // 1 — Login page
  // -----------------------------------------------------------------------
  test("renders login page", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator("h1")).toHaveText("Bluesky Chat Mapper");
    await expect(page.locator("input[placeholder*='alice']")).toBeVisible();
    await expect(page.locator("input[placeholder*='password']")).toBeVisible();
    await expect(page.locator("button:has-text('Sign in')")).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // 2 — Login → convo picker
  // -----------------------------------------------------------------------
  test("login with mock API and shows convo picker", async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto(BASE);

    await page.fill("input[placeholder*='alice']", "alice.bsky.social");
    await page.fill("input[placeholder*='password']", "hunter2");
    await page.click("button:has-text('Sign in')");

    const convos = page.locator(".convo-item");
    await expect(convos).toHaveCount(3, { timeout: 10000 });
    await expect(convos.first()).toContainText("Test Chat Squad");
  });

  // -----------------------------------------------------------------------
  // 3 — Full pipeline → graph → click node → sidebar
  // -----------------------------------------------------------------------
  test("full pipeline, graph, and sidebar messages", async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto(BASE);

    // Login
    await page.fill("input[placeholder*='alice']", "alice.bsky.social");
    await page.fill("input[placeholder*='password']", "hunter2");
    await page.click("button:has-text('Sign in')");

    // Pick convo
    await expect(page.locator(".convo-item").first()).toBeVisible({ timeout: 10000 });
    await page.locator(".convo-item").first().click();

    // Use "All time" so mock dates aren't filtered out
    await page.selectOption("select", "all");
    await page.locator("button:has-text('Start')").click();

    // Wait for pipeline → Generate Map
    const genMapBtn = page.locator("button:has-text('Generate Map')");
    await expect(genMapBtn).toBeVisible({ timeout: 60000 });
    await genMapBtn.click();

    // Graph should render with cluster nodes (SVG circles)
    const nodes = page.locator(".graph-svg g circle");
    await expect(nodes.first()).toBeVisible({ timeout: 30000 });
    expect(await nodes.count()).toBeGreaterThan(0);

    // Click a node → sidebar
    await nodes.first().click({ force: true });
    const sidebar = page.locator(".graph-sidebar");
    await expect(sidebar).toBeVisible({ timeout: 5000 });
    await expect(sidebar.locator(".sidebar-msg")).not.toHaveCount(0);
  });

  // -----------------------------------------------------------------------
  // 4 — Fuzzy search + logout
  // -----------------------------------------------------------------------
  test("fuzzy search and logout", async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto(BASE);

    // Login
    await page.fill("input[placeholder*='alice']", "alice.bsky.social");
    await page.fill("input[placeholder*='password']", "hunter2");
    await page.click("button:has-text('Sign in')");

    // Pick convo
    await expect(page.locator(".convo-item").first()).toBeVisible({ timeout: 10000 });
    await page.locator(".convo-item").first().click();

    // Pipeline
    await page.selectOption("select", "all");
    await page.locator("button:has-text('Start')").click();
    const genMapBtn = page.locator("button:has-text('Generate Map')");
    await expect(genMapBtn).toBeVisible({ timeout: 60000 });
    await genMapBtn.click();

    // Wait for graph
    await expect(page.locator(".graph-svg g circle").first()).toBeVisible({ timeout: 30000 });

    // Switch to Fuzzy mode and search
    await page.locator("label:has-text('Fuzzy')").click();
    const searchInput = page.locator('input[placeholder="Search clusters..."]');
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await searchInput.fill("Tokyo");
    await page.click("button:has-text('Search')");

    // Results should appear in sidebar
    const sidebarMeta = page.locator(".sidebar-meta");
    await expect(sidebarMeta).toBeVisible({ timeout: 10000 });
    await expect(sidebarMeta).toContainText("match");

    // Logout
    const logoutBtn = page.locator("button:has-text('Log out')");
    if (await logoutBtn.isVisible()) await logoutBtn.click();

    await expect(page.locator("h1")).toHaveText("Bluesky Chat Mapper", { timeout: 5000 });
    await expect(page.locator("input[placeholder*='alice']")).toBeVisible();
  });
});
