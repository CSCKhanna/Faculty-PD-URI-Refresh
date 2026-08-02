import assert from "node:assert/strict";
import test from "node:test";

import { extractCatalogTitles, reconcileCatalogItems, reconcileExpiredItems } from "./update-feeds.mjs";

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

  const first = reconcileCatalogItems(items, source, [], "2026-08-02");
  assert.deepEqual(first.removed, []);
  assert.equal(items[0].status, "recommended");
  assert.equal(items[0].sourceMissingCount, 1);

  const second = reconcileCatalogItems(items, source, [], "2026-08-03");
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
