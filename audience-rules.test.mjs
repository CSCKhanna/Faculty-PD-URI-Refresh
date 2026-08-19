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

test("general faculty opportunities match every faculty type", () => {
  const groups = resolveAudienceGroups({ provider: "URI-ATL", audience: ["All instructors"] });
  assert.deepEqual([...groups], ALL_FACULTY_GROUPS);
});

test("a specific faculty audience overrides a general faculty label", () => {
  const groups = resolveAudienceGroups({ provider: "URI-ATL", audience: ["All instructors", "New faculty"] });
  assert.deepEqual([...groups], ["New Faculty"]);
});

test("explicit graduate and postdoc audiences remain available with a general faculty audience", () => {
  const groups = resolveAudienceGroups({ provider: "Other", audience: ["Faculty", "Graduate students", "Postdocs"] });
  assert.deepEqual([...groups], ["Graduate Students & Postdocs", ...ALL_FACULTY_GROUPS]);
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
  assert.deepEqual([...groups], ["Graduate Students & Postdocs"]);
});
