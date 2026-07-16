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

  // -----------------------------------------------------------------------
  // 5 — Mode switching: Force Graph → Timeline → None
  // -----------------------------------------------------------------------
  test("mode switching between Force Graph, Timeline, and None", async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto(BASE);

    await page.fill("input[placeholder*='alice']", "alice.bsky.social");
    await page.fill("input[placeholder*='password']", "hunter2");
    await page.click("button:has-text('Sign in')");
    await expect(page.locator(".convo-item").first()).toBeVisible({ timeout: 10000 });
    await page.locator(".convo-item").first().click();
    await page.selectOption("select", "all");
    await page.locator("button:has-text('Start')").click();
    const genMapBtn = page.locator("button:has-text('Generate Map')");
    await expect(genMapBtn).toBeVisible({ timeout: 60000 });
    await genMapBtn.click();
    await expect(page.locator(".graph-svg g circle").first()).toBeVisible({ timeout: 30000 });

    // Force Graph is default — minimap strip visible below
    await expect(page.locator(".minimap")).toBeVisible();

    // Switch to Timeline mode
    await page.selectOption(".graph-mode-select", "timeline");
    await expect(page.locator(".graph-svg")).not.toBeVisible();
    await expect(page.locator(".timeline-full")).toBeVisible();

    // Switch to None
    await page.selectOption(".graph-mode-select", "none");
    await expect(page.locator(".graph-svg")).not.toBeVisible();
    await expect(page.locator(".timeline-full")).not.toBeVisible();

    // Switch back to Force Graph
    await page.selectOption(".graph-mode-select", "force");
    await expect(page.locator(".graph-svg g circle").first()).toBeVisible({ timeout: 5000 });
  });

  // -----------------------------------------------------------------------
  // 6 — Minimap click → sidebar, multi-select, and Deselect all
  // -----------------------------------------------------------------------
  test("minimap click, multi-select, and deselect all", async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto(BASE);

    await page.fill("input[placeholder*='alice']", "alice.bsky.social");
    await page.fill("input[placeholder*='password']", "hunter2");
    await page.click("button:has-text('Sign in')");
    await expect(page.locator(".convo-item").first()).toBeVisible({ timeout: 10000 });
    await page.locator(".convo-item").first().click();
    await page.selectOption("select", "all");
    await page.locator("button:has-text('Start')").click();
    const genMapBtn = page.locator("button:has-text('Generate Map')");
    await expect(genMapBtn).toBeVisible({ timeout: 60000 });
    await genMapBtn.click();
    await expect(page.locator(".graph-svg g circle").first()).toBeVisible({ timeout: 30000 });

    // Click a minimap bar (the first rect in the minimap strip)
    const minimapRect = page.locator(".minimap svg rect").first();
    await expect(minimapRect).toBeVisible({ timeout: 5000 });
    await minimapRect.click();

    // Sidebar should open showing the selected cluster
    const sidebar = page.locator(".graph-sidebar");
    await expect(sidebar).toBeVisible({ timeout: 5000 });

    // Click a second minimap rect (different color/cluster)
    const allMinimapRects = page.locator(".minimap svg rect");
    const rects = await allMinimapRects.all();
    const firstFill = await rects[0].getAttribute("fill");
    let secondRect = null;
    for (const r of rects) {
      if ((await r.getAttribute("fill")) !== firstFill) {
        secondRect = r;
        break;
      }
    }
    if (secondRect) {
      await secondRect.click();
      // Two clusters selected — label should contain " · "
      await expect(sidebar.locator("h3")).toContainText(" · ", { timeout: 3000 });
    }

    // Click Deselect all
    const deselectBtn = page.locator("button:has-text('Deselect all')");
    await expect(deselectBtn).toBeVisible();
    await deselectBtn.click();
    await expect(sidebar).not.toBeVisible({ timeout: 3000 });
  });

  // -----------------------------------------------------------------------
  // 7 — Semantic search returns message results
  // -----------------------------------------------------------------------
  test("semantic search shows message results", async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto(BASE);

    await page.fill("input[placeholder*='alice']", "alice.bsky.social");
    await page.fill("input[placeholder*='password']", "hunter2");
    await page.click("button:has-text('Sign in')");
    await expect(page.locator(".convo-item").first()).toBeVisible({ timeout: 10000 });
    await page.locator(".convo-item").first().click();
    await page.selectOption("select", "all");
    await page.locator("button:has-text('Start')").click();
    const genMapBtn = page.locator("button:has-text('Generate Map')");
    await expect(genMapBtn).toBeVisible({ timeout: 60000 });
    await genMapBtn.click();
    await expect(page.locator(".graph-svg g circle").first()).toBeVisible({ timeout: 30000 });

    // Semantic mode is default — search for travel content
    const searchInput = page.locator('input[placeholder="Search clusters..."]');
    await searchInput.fill("travel");
    await page.click("button:has-text('Search')");

    // Results should appear in sidebar
    const sidebarMeta = page.locator(".sidebar-meta");
    await expect(sidebarMeta).toBeVisible({ timeout: 10000 });
    await expect(sidebarMeta).toContainText("match");

    // Should have message-level results (not just cluster highlights)
    const sidebarMsgs = page.locator(".sidebar-msg");
    await expect(sidebarMsgs.first()).toBeVisible({ timeout: 5000 });
  });

  // -----------------------------------------------------------------------
  // 8 — Send message and reply
  // -----------------------------------------------------------------------
  test("send message and reply", async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto(BASE);

    await page.fill("input[placeholder*='alice']", "alice.bsky.social");
    await page.fill("input[placeholder*='password']", "hunter2");
    await page.click("button:has-text('Sign in')");
    await expect(page.locator(".convo-item").first()).toBeVisible({ timeout: 10000 });
    await page.locator(".convo-item").first().click();
    await page.selectOption("select", "all");
    await page.locator("button:has-text('Start')").click();
    const genMapBtn = page.locator("button:has-text('Generate Map')");
    await expect(genMapBtn).toBeVisible({ timeout: 60000 });
    await genMapBtn.click();
    await expect(page.locator(".graph-svg g circle").first()).toBeVisible({ timeout: 30000 });

    // Open sidebar by clicking a node
    await page.locator(".graph-svg g circle").first().click({ force: true });
    await expect(page.locator(".graph-sidebar")).toBeVisible({ timeout: 5000 });

    // Click Reply on a sidebar message
    const replyBtn = page.locator(".reply-btn").first();
    await expect(replyBtn).toBeVisible({ timeout: 5000 });
    await replyBtn.click();

    // Verify reply indicator appears
    await expect(page.locator(".reply-indicator")).toBeVisible();
    await expect(page.locator(".reply-indicator")).toContainText("Replying to:");

    // Type and send (press Enter to submit the form)
    await page.fill(".compose-input", "test reply message");
    await page.locator(".compose-send").click({ force: true });

    // Input should be cleared after successful send
    await expect(page.locator(".compose-input")).toHaveValue("", { timeout: 5000 });

    // Reply indicator should clear after send
    await expect(page.locator(".reply-indicator")).not.toBeVisible({ timeout: 5000 });
  });
});
