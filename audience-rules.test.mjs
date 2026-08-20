import assert from "node:assert/strict";
import test from "node:test";

import { AUDIENCE_GROUPS, resolveAudienceGroups } from "./audience-rules.mjs";

const ALL_FACULTY_GROUPS = [
  "New Faculty",
  "Early-Career Faculty",
  "Mid-Career Faculty",
  "Senior Faculty",
  "Part-Time Faculty",
  "Teaching-Track Faculty",
  "Tenure-Track Faculty"
];

test("general teaching opportunities match the standard faculty types", () => {
  const groups = resolveAudienceGroups({ provider: "URI-ATL", audience: ["All instructors"], topics: ["Teaching"] });
  assert.deepEqual([...groups], ALL_FACULTY_GROUPS);
});

test("general non-teaching opportunities include clinical and research faculty", () => {
  const groups = resolveAudienceGroups({ provider: "CUR", audience: ["Faculty"], topics: ["Writing", "Research"] });
  assert.deepEqual([...groups], [...ALL_FACULTY_GROUPS, "Clinical Faculty", "Research Faculty"]);
});

test("teaching-only opportunities do not infer clinical or research faculty", () => {
  const groups = resolveAudienceGroups({
    provider: "URI-ATL",
    audience: ["Faculty"],
    topics: ["Teaching", "Curriculum", "Mentoring"]
  });
  assert.equal(groups.has("Clinical Faculty"), false);
  assert.equal(groups.has("Research Faculty"), false);
});

test("clinical and research faculty can be named explicitly", () => {
  assert.deepEqual(
    [...resolveAudienceGroups({ provider: "Other", audience: ["Clinical faculty"], topics: ["Teaching"] })],
    ["Clinical Faculty"]
  );
  assert.deepEqual(
    [...resolveAudienceGroups({ provider: "Other", audience: ["Research faculty"], topics: ["Teaching"] })],
    ["Research Faculty"]
  );
});

test("a specific faculty audience overrides a general faculty label", () => {
  const groups = resolveAudienceGroups({ provider: "URI-ATL", audience: ["All instructors", "New faculty"] });
  assert.deepEqual([...groups], ["New Faculty"]);
});

test("explicit graduate and postdoc audiences remain available with a general faculty audience", () => {
  const groups = resolveAudienceGroups({ provider: "Other", audience: ["Faculty", "Graduate students", "Postdocs"] });
  assert.deepEqual([...groups], ["Graduate Students", "Postdocs", ...ALL_FACULTY_GROUPS]);
});

test("graduate students and postdocs can be filtered independently", () => {
  assert.deepEqual(
    [...resolveAudienceGroups({ provider: "Other", audience: ["Graduate students"] })],
    ["Graduate Students"]
  );
  assert.deepEqual(
    [...resolveAudienceGroups({ provider: "Other", audience: ["Postdocs"] })],
    ["Postdocs"]
  );
});

test("future faculty opportunities match graduate students and postdocs", () => {
  const groups = resolveAudienceGroups({ provider: "Other", audience: ["Future faculty"] });
  assert.deepEqual([...groups], ["Graduate Students", "Postdocs"]);
});

test("every NCFDD opportunity matches every audience category", () => {
  const groups = resolveAudienceGroups({ provider: "NCFDD", audience: ["Faculty"] });
  assert.deepEqual([...groups], AUDIENCE_GROUPS.map((group) => group.label));
});

test("leadership-specific opportunities stay leadership-specific", () => {
  const groups = resolveAudienceGroups({ provider: "EAB", audience: ["Faculty", "Chairs"] });
  assert.deepEqual([...groups], ["Department Chairs"]);
});

test("every CIRTL opportunity is limited to graduate students and postdocs", () => {
  const groups = resolveAudienceGroups({ provider: "CIRTL", audience: ["Faculty", "Chairs", "Program directors"] });
  assert.deepEqual([...groups], ["Graduate Students", "Postdocs"]);
});
