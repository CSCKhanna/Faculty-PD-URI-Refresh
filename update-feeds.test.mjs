import assert from "node:assert/strict";
import test from "node:test";

import { reconcileExpiredItems } from "./update-feeds.mjs";

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
