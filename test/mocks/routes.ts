/**
 * Playwright route interception helpers.
 * Registers handlers on `page` to intercept XRPC calls and return mock data.
 */

import type { Page } from "@playwright/test";
import { mockSession, mockConvos, buildMessages, mockProfiles } from "./data";

export async function mockApiRoutes(page: Page) {
  const msgs = buildMessages();

  // Session creation
  await page.route("**/xrpc/com.atproto.server.createSession", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockSession),
    });
  });

  // Session refresh
  await page.route("**/xrpc/com.atproto.server.refreshSession", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockSession),
    });
  });

  // List convos
  await page.route("**/xrpc/chat.bsky.convo.listConvos*", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockConvos),
    });
  });

  // Get messages (single page = all messages, no pagination needed for tests)
  await page.route("**/xrpc/chat.bsky.convo.getMessages*", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: msgs.messages,
        relatedProfiles: mockProfiles,
      }),
    });
  });
}
