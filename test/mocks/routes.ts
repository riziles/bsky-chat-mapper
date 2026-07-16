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

  // Send message
  await page.route((url) => url.pathname.includes("/xrpc/chat.bsky.convo.sendMessage"), (route) => {
    const rawPostData = route.request().postData();
    const body = rawPostData ? JSON.parse(rawPostData) : {};
    const msgId = `chat.es.bsky:msg-test-${Date.now()}`;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: msgId,
        rev: "rev-1",
        text: body.message?.text ?? "",
        sender: { did: mockSession.did },
        sentAt: new Date().toISOString(),
        ...(body.message?.replyTo ? {
          replyTo: { $type: "chat.bsky.convo.defs#messageView", id: body.message.replyTo.messageId, rev: "rev-0", text: "...", sender: { did: "did:plc:other" }, sentAt: new Date().toISOString() },
        } : {}),
        $type: "chat.bsky.convo.defs#messageView",
      }),
    });
  });
}
