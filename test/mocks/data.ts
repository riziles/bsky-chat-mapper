/**
 * Mock Bluesky API response data for Playwright tests.
 * Routes are intercepted at the XRPC layer so no real API calls leave the browser.
 */

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

export const senders = {
  alice: { did: "did:plc:alice111", handle: "alice.bsky.social", displayName: "Alice" },
  bob:   { did: "did:plc:bob222", handle: "bob.bsky.social", displayName: "Bob" },
  carol: { did: "did:plc:carol333", handle: "carol.bsky.social", displayName: "Carol" },
  dave:  { did: "did:plc:dave444", handle: "dave.bsky.social", displayName: "Dave" },
  eve:   { did: "did:plc:eve555", handle: "eve.bsky.social", displayName: "Eve" },
};

// ---------------------------------------------------------------------------
// Mock session
// ---------------------------------------------------------------------------

export const mockSession = {
  did: senders.alice.did,
  accessJwt: "eyJ...mock-access-token",
  refreshJwt: "eyJ...mock-refresh-token",
  handle: senders.alice.handle,
  email: "alice@example.com",
  emailConfirmed: true,
  emailAuthFactor: false,
  active: true,
};

// ---------------------------------------------------------------------------
// Helper: build convos
// ---------------------------------------------------------------------------

function convoView(opts: {
  id: string;
  name: string;
  memberCount: number;
  lastText: string;
  lastSentAt: string;
}) {
  return {
    id: opts.id,
    rev: "rev-1",
    members: Object.values(senders).map((s) => ({
      did: s.did,
      handle: s.handle,
      displayName: s.displayName,
    })),
    muted: false,
    status: "accepted",
    unreadCount: 3,
    kind: {
      $type: "chat.bsky.convo.defs#groupConvo" as const,
      createdAt: "2025-01-01T00:00:00Z",
      lockStatus: "unlocked",
      lockStatusModerationOverride: false,
      memberCount: opts.memberCount,
      memberLimit: 100,
      name: opts.name,
    },
    lastMessage: {
      $type: "chat.bsky.convo.defs#messageView" as const,
      id: `lm-${opts.id}`,
      rev: "rev",
      text: opts.lastText,
      sender: { did: senders.bob.did },
      sentAt: opts.lastSentAt,
    },
  };
}

export const mockConvos = {
  convos: [
    convoView({
      id: "convo-test-1",
      name: "Test Chat Squad",
      memberCount: 5,
      lastText: "Anyone seen the new Dune series?",
      lastSentAt: "2026-07-12T18:30:00Z",
    }),
    convoView({
      id: "convo-test-2",
      name: "Weekend Warriors",
      memberCount: 3,
      lastText: "Beach this Saturday?",
      lastSentAt: "2026-07-12T10:00:00Z",
    }),
    convoView({
      id: "convo-test-3",
      name: "Work Stuff",
      memberCount: 4,
      lastText: "Deploy is green, go for it",
      lastSentAt: "2026-07-11T23:00:00Z",
    }),
  ],
};

// ---------------------------------------------------------------------------
// Messages  (interleaved topics with reply chains)
// ---------------------------------------------------------------------------

let msgId = 0;
function mid() { return `msg-${++msgId}`; }
function ts(dayOffset: number, hour: number, min: number) {
  const d = new Date("2026-07-13T00:00:00Z");
  d.setDate(d.getDate() - dayOffset);
  d.setHours(hour, min, 0, 0);
  return d.toISOString();
}

function msg(sender: typeof senders.alice, text: string, day: number, hour: number, min: number, replyTo?: string): RawMsg {
  const out: RawMsg = {
    $type: "chat.bsky.convo.defs#messageView" as const,
    id: mid(),
    rev: "r-1",
    text,
    sender: { did: sender.did },
    sentAt: ts(day, hour, min),
  };
  if (replyTo) out.replyTo = { $type: "chat.bsky.convo.defs#replyRef", messageId: replyTo };
  return out;
}

interface RawMsg {
  $type: "chat.bsky.convo.defs#messageView";
  id: string;
  rev: string;
  text: string;
  sender: { did: string };
  sentAt: string;
  replyTo?: { $type: string; messageId: string };
}

// Build 120 messages across 6 topics with interleaved timing and reply chains
export function buildMessages(): { messages: RawMsg[] } {
  const S = senders;
  const msgs: RawMsg[] = [];

  // ---- Day 7 (oldest): dinner + TypeScript ----
  msgs.push(msg(S.alice, "Anyone up for dinner this Friday?", 7, 18, 0));      // 1 – dinner start
  const m1 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.bob, "Has anyone tried the new TypeScript 5.5 decorators?", 7, 18, 15)); // 2 – ts start
  const m2 = msgs[msgs.length - 1].id;

  msgs.push(msg(S.carol, "I'm in! How about that Italian place on 5th?", 7, 18, 20, m1)); // 3 – reply to dinner
  msgs.push(msg(S.eve, "TS decorators are so much cleaner now. The legacy ones were awful.", 7, 18, 22, m2)); // 4 – reply to ts
  msgs.push(msg(S.dave, "Italian sounds great. 7pm work for everyone?", 7, 18, 30, m1)); // 5 – reply to dinner

  msgs.push(msg(S.alice, "I was reading the TC39 proposal - the implementation details are wild", 7, 18, 35, m2)); // 6 – ts chain
  msgs.push(msg(S.carol, "Yeah 7pm works! I'll make a reservation.", 7, 18, 40, m1)); // 7 – dinner

  // ---- Day 6: movies + travel ----
  msgs.push(msg(S.bob, "Anyone seen Dune Part 3 yet? No spoilers!", 6, 12, 0)); // 8 – movie start
  const m8 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.eve, "Planning a trip to Tokyo next month. Any recommendations?", 6, 12, 10)); // 9 – travel start
  const m9 = msgs[msgs.length - 1].id;

  msgs.push(msg(S.dave, "Dune was incredible. Villeneuve outdid himself.", 6, 12, 15, m8));
  msgs.push(msg(S.alice, "Tokyo is AMAZING. You have to visit Shibuya and Tsukiji market.", 6, 12, 20, m9));
  msgs.push(msg(S.carol, "The visuals in Dune are just... chef's kiss", 6, 13, 0, m8));

  msgs.push(msg(S.bob, "If you go to Tokyo, try the ramen at Ichiran. Life-changing.", 6, 13, 10, m9));
  msgs.push(msg(S.eve, "Oh I've heard about Ichiran! Is it worth the queue?", 6, 13, 15, m9));
  msgs.push(msg(S.bob, "100% worth it. Go at 3pm on a weekday, no line.", 6, 13, 20, m9));

  msgs.push(msg(S.dave, "The score for Dune... Hans Zimmer is a genius.", 6, 14, 0, m8));
  msgs.push(msg(S.alice, "I need to watch it in IMAX. Does anyone want to go again?", 6, 14, 10, m8));

  // ---- Day 5: TypeScript deep dive + dinner follow-up ----
  msgs.push(msg(S.eve, "We really should migrate the project to TS 5.5. The `isolatedDeclarations` flag is huge.", 5, 10, 0)); // 18
  const m18 = msgs[msgs.length - 1].id;

  msgs.push(msg(S.bob, "Agreed. The perf gains from `isolatedDeclarations` alone justify it.", 5, 10, 5, m18));
  msgs.push(msg(S.dave, "What about our monorepo setup? Does turborepo handle it okay?", 5, 10, 10, m18));
  msgs.push(msg(S.eve, "Turborepo 2.0 added first-class TS 5.5 support. We're good.", 5, 10, 15, m18));

  // dinner updates
  msgs.push(msg(S.carol, "Reservation confirmed! Friday at 7pm, table for 5.", 5, 14, 0)); // 22
  const m22 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.alice, "You're the best Carol! Should we meet there or carpool?", 5, 14, 5, m22));
  msgs.push(msg(S.bob, "I can drive. I'll pick up Dave and Eve.", 5, 14, 10, m22));
  msgs.push(msg(S.dave, "Shotgun!", 5, 14, 12, m22));

  // ---- Day 4: memes/jokes ----
  msgs.push(msg(S.bob, "Why do programmers prefer dark mode?", 4, 9, 0)); // 26
  const m26 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.bob, "Because light attracts bugs! 🤣", 4, 9, 1, m26));
  msgs.push(msg(S.dave, "lmaoooo", 4, 9, 2, m26));

  msgs.push(msg(S.carol, "my cat walked across the keyboard and somehow compiled the project", 4, 14, 0)); // 29
  const m29 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.eve, "that cat is more productive than I am", 4, 14, 5, m29));
  msgs.push(msg(S.alice, "hire the cat", 4, 14, 10, m29));

  msgs.push(msg(S.bob, "I explained recursion to my rubber duck. Now the duck is stuck in a loop.", 4, 17, 0)); // 32
  msgs.push(msg(S.dave, "💀", 4, 17, 1));
  msgs.push(msg(S.eve, "error: rubber duck quota exceeded", 4, 17, 3));

  // ---- Day 3: travel planning + movies ----
  msgs.push(msg(S.eve, "Ok I'm booking the Tokyo trip! Any must-see spots besides Ichiran?", 3, 10, 0)); // 35
  const m35 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.alice, "Akihabara for tech/anime stuff. Meiji shrine for peace and quiet.", 3, 10, 5, m35));
  msgs.push(msg(S.bob, "Ghibli Museum! But you need to book tickets way in advance.", 3, 10, 10, m35));
  msgs.push(msg(S.eve, "Ooh Ghibli museum sounds amazing. How far in advance?", 3, 10, 15, m35));
  msgs.push(msg(S.bob, "Like a month. They sell out instantly on the 10th of each month.", 3, 10, 20, m35));

  msgs.push(msg(S.dave, "What about Kyoto? The temples there are stunning.", 3, 10, 25, m35));
  msgs.push(msg(S.alice, "Yes! Golden Pavilion is a must. And the bamboo grove.", 3, 10, 30, m35));
  msgs.push(msg(S.eve, "Adding all of this to my itinerary. Thanks y'all!", 3, 10, 35, m35));

  // movies
  msgs.push(msg(S.alice, "Just watched The Substance. What a ride.", 3, 20, 0)); // 43
  const m43 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.bob, "Demi Moore was incredible in that. Oscar worthy.", 3, 20, 5, m43));
  msgs.push(msg(S.carol, "The third act went absolutely wild. Did not expect that.", 3, 20, 10, m43));
  msgs.push(msg(S.eve, "body horror isn't usually my thing but this was brilliant", 3, 20, 15, m43));

  // ---- Day 2: TypeScript migration + random ----
  msgs.push(msg(S.eve, "I started the TS 5.5 migration branch. Should be done by end of week.", 2, 11, 0)); // 47
  const m47 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.bob, "Awesome! LMK if you hit any type narrowing issues. Those can be tricky.", 2, 11, 5, m47));
  msgs.push(msg(S.eve, "Already found one with discriminated unions and `satisfies` operator.", 2, 11, 10, m47));
  msgs.push(msg(S.dave, "The `satisfies` + discriminated union is a known TS 5.5 edge case. There's a workaround.", 2, 11, 15, m47));
  msgs.push(msg(S.bob, "Yeah you need to add an explicit return type annotation in those cases.", 2, 11, 20, m47));

  // dinner finale
  msgs.push(msg(S.dave, "It's Friday! Still on for Italian tonight?", 2, 16, 0)); // 52
  const m52 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.alice, "Absolutely! Can't wait. Been thinking about pasta all week.", 2, 16, 3, m52));
  msgs.push(msg(S.carol, "I pre-gamed by looking at the menu online. The risotto looks incredible.", 2, 16, 5, m52));
  msgs.push(msg(S.bob, "I'm picking everyone up at 6:30. Be ready or get left behind! 😤", 2, 16, 8, m52));
  msgs.push(msg(S.eve, "Better not leave me, I live closest to you Bob!", 2, 16, 10, m52));

  // random
  msgs.push(msg(S.alice, "Why is it that code I wrote 6 months ago looks like someone else wrote it", 2, 20, 0)); // 57
  const m57 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.bob, "Because you've grown as a developer! Or forgotten everything. 50/50.", 2, 20, 2, m57));
  msgs.push(msg(S.carol, "I found a comment in my old code that just said 'sorry'", 2, 20, 5, m57));
  msgs.push(msg(S.dave, "TBF that's better than no comment at all", 2, 20, 7, m57));

  // ---- Day 1 (today): fresh topics ----
  msgs.push(msg(S.eve, "How was dinner last night? I woke up still full.", 1, 10, 0)); // 61
  const m61 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.alice, "SO good. That tiramisu was next level.", 1, 10, 2, m61));
  msgs.push(msg(S.carol, "We need to make Italian dinner a monthly thing.", 1, 10, 4, m61));
  msgs.push(msg(S.dave, "Seconded. But next time we try that new Thai place?", 1, 10, 6, m61));
  msgs.push(msg(S.bob, "Thai works. Let's aim for the first Friday of next month?", 1, 10, 8, m61));

  // new ts talk
  msgs.push(msg(S.dave, "Just found out about Bun 2.0. The native TS support is wild.", 1, 14, 0)); // 66
  const m66 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.bob, "Wait, Bun has a native TS transpiler now? No more tsc?", 1, 14, 2, m66));
  msgs.push(msg(S.dave, "Yeah it strips types and runs directly. No config needed.", 1, 14, 5, m66));
  msgs.push(msg(S.eve, "That's huge for dev speed. No more watching tsc restart.", 1, 14, 7, m66));
  msgs.push(msg(S.bob, "Time to benchmark it against our current build. Could save minutes per CI run.", 1, 14, 10, m66));

  // movie talk
  msgs.push(msg(S.carol, "Just saw Nosferatu. Robert Eggers is a madman in the best way.", 1, 17, 0)); // 71
  const m71 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.alice, "The cinematography was stunning. Every frame a painting.", 1, 17, 3, m71));
  msgs.push(msg(S.dave, "Bill Skarsgård as Orlok... genuinely terrifying.", 1, 17, 5, m71));
  msgs.push(msg(S.bob, "Eggers' attention to historical detail is unmatched. The costumes alone.", 1, 17, 8, m71));

  // travel update
  msgs.push(msg(S.eve, "Tokyo update: flights booked! Sept 15-30. Ghibli Museum tickets secured! 🎉", 1, 19, 0)); // 75
  const m75 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.alice, "Congrats Eve!! You're going to love it.", 1, 19, 2, m75));
  msgs.push(msg(S.bob, "Don't forget to get a Suica card at the airport. Essential for trains.", 1, 19, 5, m75));
  msgs.push(msg(S.carol, "Bring me back some matcha KitKats!", 1, 19, 8, m75));
  msgs.push(msg(S.dave, "And weird KitKat flavors. Wasabi KitKat is a thing.", 1, 19, 10, m75));

  // memes/jokes
  msgs.push(msg(S.bob, "I told my codebase 'you complete me' and it segfaulted. Tough crowd.", 1, 21, 0)); // 80
  msgs.push(msg(S.alice, "💀💀💀", 1, 21, 1));
  msgs.push(msg(S.eve, "mine just responds with 'undefined' whenever I ask it something", 1, 21, 3));
  msgs.push(msg(S.dave, "my codebase is like a cat - it ignores me until it needs food", 1, 21, 5));

  // ts migration progress check
  msgs.push(msg(S.bob, "Eve, how's the TS 5.5 migration going?", 1, 22, 0)); // 84
  const m84 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.eve, "Almost done! Down to 12 type errors from 200+. The `satisfies` edge cases were the worst.", 1, 22, 2, m84));
  msgs.push(msg(S.dave, "Did the explicit return type trick work?", 1, 22, 4, m84));
  msgs.push(msg(S.eve, "Yep! Had to do it in 4 places but it fixed all of them.", 1, 22, 6, m84));
  msgs.push(msg(S.bob, "PR tomorrow then? I'll review first thing.", 1, 22, 8, m84));

  // movie discussion continues
  msgs.push(msg(S.eve, "OK back to movies - what's everyone's top movie of 2026 so far?", 1, 23, 0)); // 89
  const m89 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.bob, "Dune Part 3, hands down. Nothing comes close.", 1, 23, 2, m89));
  msgs.push(msg(S.dave, "Honestly... The Substance. It just stayed with me.", 1, 23, 4, m89));
  msgs.push(msg(S.alice, "Agreed with Dave. The Substance was unforgettable.", 1, 23, 6, m89));
  msgs.push(msg(S.carol, "Nosferatu for me. Eggers can do no wrong.", 1, 23, 8, m89));
  msgs.push(msg(S.eve, "I'd say Flow. That cat movie made me cry three times.", 1, 23, 10, m89));

  // more travel
  msgs.push(msg(S.eve, "Does anyone have hotel recs for Tokyo? I'm looking at Shinjuku area.", 1, 23, 15)); // 95
  const m95 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.alice, "I stayed at the Keio Plaza. Great location, reasonable price.", 1, 23, 17, m95));
  msgs.push(msg(S.bob, "Also check out APA hotels. Business hotels, small rooms but cheap and everywhere.", 1, 23, 20, m95));
  msgs.push(msg(S.eve, "Thanks! Leaning toward Shinjuku for the train connections.", 1, 23, 23, m95));

  // more ts
  msgs.push(msg(S.dave, "Anyone tried Vite 6 with the new Rolldown bundler? Supposedly 5x faster.", 1, 23, 30)); // 99
  const m99 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.bob, "We're on Vite 5 still. Is 6 stable yet?", 1, 23, 32, m99));
  msgs.push(msg(S.eve, "Just hit RC3. Should be stable soon. The Rolldown migration is the main feature.", 1, 23, 35, m99));
  msgs.push(msg(S.dave, "I tested it on a side project. Build time went from 12s to 2s. No joke.", 1, 23, 38, m99));
  msgs.push(msg(S.bob, "Ok that's compelling. Let's track it for Q4 upgrade.", 1, 23, 40, m99));

  // more casual chat
  msgs.push(msg(S.alice, "It's too hot today. I melted just walking to get coffee.", 1, 23, 45)); // 104
  msgs.push(msg(S.bob, "Same. My AC is fighting for its life.", 1, 23, 46));
  msgs.push(msg(S.carol, "I've been drinking iced coffee exclusively since June.", 1, 23, 48));
  msgs.push(msg(S.eve, "Hot take: cold brew > iced coffee. Smoother, less acidic.", 1, 23, 50));
  const m107 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.dave, "Hot take: regular hot coffee > everything. Even in summer.", 1, 23, 52, m107));
  msgs.push(msg(S.alice, "Dave no.", 1, 23, 53));
  msgs.push(msg(S.carol, "Dave we need to talk.", 1, 23, 54));
  msgs.push(msg(S.bob, "This is the most controversial thing said in this chat.", 1, 23, 55));

  // tag on some final memes
  msgs.push(msg(S.dave, "Why did the function cross the road?", 1, 23, 56)); // 112
  const m112 = msgs[msgs.length - 1].id;
  msgs.push(msg(S.dave, "Because it was called.", 1, 23, 57, m112));
  msgs.push(msg(S.alice, "get out", 1, 23, 58));
  msgs.push(msg(S.bob, "that joke was a null pointer", 1, 23, 59));
  msgs.push(msg(S.carol, "segfault: joke not found", 1, 23, 60));
  msgs.push(msg(S.eve, "TypeError: joke is not funny", 1, 23, 61));

  return { messages: msgs };
}

// ---------------------------------------------------------------------------
// Profiles for relatedProfiles field
// ---------------------------------------------------------------------------

export const mockProfiles = Object.values(senders).map((s) => ({
  did: s.did,
  handle: s.handle,
  displayName: s.displayName,
}));
