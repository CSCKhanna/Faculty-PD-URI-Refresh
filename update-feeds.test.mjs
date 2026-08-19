import assert from "node:assert/strict";
import test from "node:test";

import {
  extractCatalogItems,
  extractCatalogTitles,
  reconcileCatalogItems,
  reconcileExpiredItems,
  refreshNcfddWritingChallenge
} from "./update-feeds.mjs";

function training(overrides = {}) {
  return {
    id: "test-training",
    status: "recommended",
    datePrecision: "exact",
    endDate: "2026-07-26",
    ...overrides
  };
}

test("archives exact events whose end date is before today", () => {
  const items = [training()];

  assert.deepEqual(reconcileExpiredItems(items, "2026-07-27"), { archived: 1, restored: 0 });
  assert.equal(items[0].status, "expired");
  assert.equal(items[0].statusBeforeExpiry, "recommended");
  assert.equal(items[0].expiredAt, "2026-07-27");
});

test("keeps events that end today or later", () => {
  const items = [
    training({ endDate: "2026-07-27" }),
    training({ id: "future", endDate: "2026-07-28" })
  ];

  assert.deepEqual(reconcileExpiredItems(items, "2026-07-27"), { archived: 0, restored: 0 });
  assert.ok(items.every((item) => item.status === "recommended"));
});

test("keeps ongoing, recommended-window, placeholder, and opted-out records", () => {
  const items = [
    training({ datePrecision: "ongoing" }),
    training({ id: "window", datePrecision: "recommended-window" }),
    training({ id: "placeholder", datePrecision: "placeholder" }),
    training({ id: "recording", keepAfterEnd: true })
  ];

  assert.deepEqual(reconcileExpiredItems(items, "2026-07-27"), { archived: 0, restored: 0 });
  assert.ok(items.every((item) => item.status === "recommended"));
});

test("archives expired updater-detected items", () => {
  const items = [training({ status: "discovered", datePrecision: "detected" })];

  assert.deepEqual(reconcileExpiredItems(items, "2026-07-27"), { archived: 1, restored: 0 });
  assert.equal(items[0].statusBeforeExpiry, "discovered");
});

test("restores an archived recurring item when its date moves into the future", () => {
  const items = [training({
    status: "expired",
    statusBeforeExpiry: "recommended",
    expiredAt: "2026-07-20",
    endDate: "2026-08-10"
  })];

  assert.deepEqual(reconcileExpiredItems(items, "2026-07-27"), { archived: 0, restored: 1 });
  assert.equal(items[0].status, "recommended");
  assert.equal("statusBeforeExpiry" in items[0], false);
  assert.equal("expiredAt" in items[0], false);
});

test("ignores malformed dates", () => {
  const items = [training({ endDate: "2026-02-31" })];

  assert.deepEqual(reconcileExpiredItems(items, "2026-07-27"), { archived: 0, restored: 0 });
  assert.equal(items[0].status, "recommended");
});

test("extracts provider program titles without logistics labels", () => {
  const html = `
    <p><strong>Faculty Learning Day</strong> (ALL)<br>Dates: September 3</p>
    <p><strong>Registration</strong></p>
    <p><strong>Additional Dates/Times:</strong></p>
    <p><strong>Book Club &#8211; Faculty Life</strong></p>
    <table><tr><td><strong>Brightspace Basics (ALL)</strong><br>Self-paced.</td></tr></table>
  `;

  assert.deepEqual(extractCatalogTitles(html), ["Faculty Learning Day", "Book Club - Faculty Life", "Brightspace Basics"]);
});

test("catalog reconciliation waits two successful misses before removal", () => {
  const items = [training({
    id: "uri-atl-existing",
    title: "Existing Program",
    endDate: "2026-12-01"
  })];
  const source = {
    key: "uri_atl",
    provider: "URI-ATL",
    label: "URI ATL",
    url: "https://example.edu/atl",
    type: "event-page",
    catalogSync: { itemIdPrefix: "uri-atl-", missingRunsBeforeArchive: 2 }
  };

  const first = reconcileCatalogItems(items, source, ["Another Program"], "2026-08-02");
  assert.deepEqual(first.removed, []);
  assert.equal(items[0].status, "recommended");
  assert.equal(items[0].sourceMissingCount, 1);

  const second = reconcileCatalogItems(items, source, ["Another Program"], "2026-08-03");
  assert.deepEqual(second.removed, ["Existing Program"]);
  assert.equal(items[0].status, "source-removed");
});

test("catalog reconciliation discovers additions and restores returned items", () => {
  const items = [training({
    id: "uri-atl-returned",
    title: "Returned Program",
    status: "source-removed",
    statusBeforeSourceRemoval: "recommended",
    sourceMissingCount: 2,
    endDate: "2026-12-01"
  })];
  const source = {
    key: "uri_atl",
    provider: "URI-ATL",
    label: "URI ATL",
    url: "https://example.edu/atl",
    type: "event-page",
    catalogSync: { itemIdPrefix: "uri-atl-", missingRunsBeforeArchive: 2 }
  };

  const result = reconcileCatalogItems(items, source, ["Returned Program", "New Program"], "2026-08-04");
  assert.deepEqual(result.restored, ["Returned Program"]);
  assert.equal(items[0].status, "recommended");
  assert.equal(result.discoveries[0].title, "New Program");
});

test("catalog reconciliation ignores an unexpectedly empty extraction", () => {
  const items = [training({ id: "uri-atl-existing", title: "Existing Program" })];
  const source = {
    key: "uri_atl",
    provider: "URI-ATL",
    catalogSync: { itemIdPrefix: "uri-atl-", minimumItems: 2 }
  };

  const result = reconcileCatalogItems(items, source, [], "2026-08-05");
  assert.equal(result.status, "degraded");
  assert.equal(items[0].sourceMissingCount, undefined);
  assert.deepEqual(result.removed, []);
});

test("catalog reconciliation immediately hides updater-created logistics labels", () => {
  const items = [training({
    id: "detected-uri-atl-logistics",
    title: "All sessions will be held via Zoom.",
    catalogSource: "uri_atl",
    detectedByUpdater: true
  })];
  const source = { key: "uri_atl", provider: "URI-ATL", catalogSync: {} };

  const result = reconcileCatalogItems(items, source, ["Real Program"], "2026-08-19");
  assert.equal(items[0].status, "source-removed");
  assert.equal(items[0].sourceRemovalReason, "catalog-invalid");
  assert.deepEqual(result.removed, ["All sessions will be held via Zoom."]);
});

test("repairs the legacy Summer 2026 Writing Challenge before adding Summer 2027", () => {
  const items = [training({
    id: "ncfdd-writing-challenge-july-2026",
    provider: "NCFDD",
    title: "14-Day Writing Challenge: Summer Session",
    startDate: "2027-06-07",
    endDate: "2027-06-20"
  })];
  const source = { key: "ncfdd_writing_challenge", url: "https://example.org/writing" };
  const text = "Summer 2027 Session: June 7 - June 20, 2027";

  const discoveries = refreshNcfddWritingChallenge(items, source, text, "2026-08-19");
  assert.equal(items[0].startDate, "2026-07-06");
  assert.equal(items[0].status, "expired");
  assert.equal(discoveries[0].title, "14-Day Writing Challenge: Summer 2027 Session");
});

test("extracts configured event heading levels and filters labels", () => {
  const html = `
    <h3>September 2026</h3>
    <h4>Writing an Effective Teaching Philosophy Statement</h4>
    <h4>Event Views Navigation</h4>
    <h4>Rethinking Assessment Design in the Age of AI</h4>
  `;

  assert.deepEqual(extractCatalogTitles(html, { headingLevels: [4] }), [
    "Writing an Effective Teaching Philosophy Statement",
    "Rethinking Assessment Design in the Age of AI"
  ]);
});

test("adds future NCFDD writing challenge sessions without overwriting another season", () => {
  const items = [training({
    id: "ncfdd-writing-challenge-summer-2026",
    provider: "NCFDD",
    title: "14-Day Writing Challenge: Summer Session",
    startDate: "2026-07-06",
    endDate: "2026-07-19"
  })];
  const source = { key: "ncfdd_writing_challenge", url: "https://example.org/writing" };
  const text = "Fall 2026 Session: September 21 - October 4, 2026 Spring 2027 Session: February 15 - February 28, 2027";

  const discoveries = refreshNcfddWritingChallenge(items, source, text, "2026-08-19");
  assert.equal(items[0].startDate, "2026-07-06");
  assert.deepEqual(discoveries.map((item) => item.title), [
    "14-Day Writing Challenge: Fall 2026 Session",
    "14-Day Writing Challenge: Spring 2027 Session"
  ]);
  assert.ok(discoveries.every((item) => item.status === "discovered" && item.datePrecision === "exact"));
});

test("extracts structured events with exact dates and direct links", () => {
  const html = `<script type="application/ld+json">[{"@type":"Event","name":"AI Teaching Studio","startDate":"2026-09-30T10:00:00-05:00","endDate":"2026-09-30T11:15:00-05:00","url":"https://example.org/ai-studio","description":"A practical studio."}]</script>`;
  const [item] = extractCatalogItems(html, { structuredDataEvents: true });

  assert.equal(item.title, "AI Teaching Studio");
  assert.equal(item.startDate, "2026-09-30T10:00:00-05:00");
  assert.equal(item.url, "https://example.org/ai-studio");
});

test("extracts CUR calendar events with dates and filters out deadlines", () => {
  const html = `
    <h3><a href="/workshop">NACE-CUR Workshop Series Session 1</a></h3>
    <div class="event-dates">When: Tue, Oct 13, 2026 from 09:00 AM</div>
    <h3><a href="/deadline">Research Award Deadline</a></h3>
    <div class="event-dates">When: Wed, Oct 14, 2026 from 09:00 AM</div>
  `;
  const items = extractCatalogItems(html, {
    curCalendarEvents: true,
    baseUrl: "https://community.cur.org/events/calendar",
    includePatterns: ["Workshop"],
    excludePatterns: ["Deadline"]
  });

  assert.deepEqual(items, [{
    title: "NACE-CUR Workshop Series Session 1",
    url: "https://community.cur.org/workshop",
    startDate: "2026-10-13",
    endDate: "2026-10-13",
    format: "Provider event"
  }]);
});
