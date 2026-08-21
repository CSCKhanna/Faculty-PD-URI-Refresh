import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const data = JSON.parse(fs.readFileSync(new URL("./data/trainings.json", import.meta.url), "utf8"));
const sourceData = JSON.parse(fs.readFileSync(new URL("./data/sources.json", import.meta.url), "utf8"));
const iacrItems = data.trainings.filter((item) => item.provider === "URI-IACR");
const scheduled = iacrItems.filter((item) => item.iacrSchedule === "fall-2026");
const selfPaced = iacrItems.filter((item) => item.iacrLibrary === true);

test("URI-IACR import includes every dated and self-paced opportunity", () => {
  assert.equal(iacrItems.length, 31);
  assert.equal(scheduled.length, 22);
  assert.equal(selfPaced.length, 9);
  assert.equal(scheduled.filter((item) => item.registrationUrl).length, 20);
});

test("URI-IACR records have unique IDs and required public fields", () => {
  const allIds = data.trainings.map((item) => item.id);
  assert.equal(new Set(allIds).size, allIds.length);

  for (const item of iacrItems) {
    assert.ok(item.title);
    assert.ok(item.sourceUrl);
    assert.ok(item.description);
    assert.ok(item.audience.includes("Faculty"));
    assert.ok(item.audience.includes("Graduate students"));
    assert.ok(item.audience.includes("Postdocs"));
  }
});

test("dated IACR sessions are exact future events and self-paced groups remain ongoing", () => {
  for (const item of scheduled) {
    assert.equal(item.datePrecision, "exact");
    assert.equal(item.startDate, item.endDate);
    assert.ok(item.startDate > "2026-08-21");
  }

  for (const item of selfPaced) {
    assert.equal(item.datePrecision, "ongoing");
    assert.match(item.dateLabel, /Self-paced/);
  }
});

test("SBDC schedule entries retain their participation-confirmation caveat", () => {
  const sbdc = scheduled.filter((item) => item.title === "SBDC Training");
  assert.equal(sbdc.length, 2);
  for (const item of sbdc) {
    assert.equal(item.accessStatus, "confirm");
    assert.match(item.access, /confirm participation details/i);
    assert.equal(item.registrationUrl, undefined);
  }
});

test("nightly updater checks both IACR public source pages", () => {
  const sources = sourceData.sources.filter((source) => source.provider === "URI-IACR");
  assert.deepEqual(
    sources.map((source) => source.key).sort(),
    ["uri_iacr_research_training", "uri_iacr_workshops"]
  );
  assert.ok(sources.every((source) => source.enabled && source.discover === false));
});
