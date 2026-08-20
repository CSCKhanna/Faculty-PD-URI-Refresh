export const AUDIENCE_GROUPS = [
  {
    label: "Graduate Students",
    aliases: ["Future faculty", "Graduate students", "Graduate teaching assistants"]
  },
  {
    label: "Postdocs",
    aliases: ["Future faculty", "Postdocs", "Postdoctoral scholars", "Postdoctoral fellows"]
  },
  {
    label: "New Faculty",
    aliases: ["New faculty", "New full-time faculty"]
  },
  {
    label: "Early-Career Faculty",
    aliases: ["Early-career faculty", "Pre-tenure faculty"]
  },
  {
    label: "Mid-Career Faculty",
    aliases: ["Mid-career faculty", "Associate professors"]
  },
  {
    label: "Senior Faculty",
    aliases: ["Senior faculty", "Full professors"]
  },
  {
    label: "Part-Time Faculty",
    aliases: ["Part-time faculty", "URI employees who teach part time"]
  },
  {
    label: "Teaching-Track Faculty",
    aliases: ["Teaching-track faculty"]
  },
  {
    label: "Tenure-Track Faculty",
    aliases: ["Tenure-track faculty"]
  },
  {
    label: "Clinical Faculty",
    aliases: ["Clinical faculty", "Clinical-track faculty", "Clinical professors", "Clinical instructors"]
  },
  {
    label: "Research Faculty",
    aliases: ["Research faculty", "Research-track faculty", "Research professors", "Research scientists"]
  },
  {
    label: "Associate Deans",
    aliases: ["Associate deans"]
  },
  {
    label: "Department Chairs",
    aliases: ["Department chairs", "Chairs"]
  }
];

export const NCFDD_ALL_AUDIENCES = [
  "Graduate students",
  "Postdocs",
  "New faculty",
  "Early-career faculty",
  "Associate professors",
  "Full professors",
  "Part-time faculty",
  "Teaching-track faculty",
  "Tenure-track faculty",
  "Clinical faculty",
  "Research faculty",
  "Associate deans",
  "Department chairs"
];

const SPECIALIZED_FACULTY_GROUPS = new Set(["Clinical Faculty", "Research Faculty"]);
const GENERAL_FACULTY_GROUPS = AUDIENCE_GROUPS
  .map((group) => group.label)
  .filter((label) => label.endsWith("Faculty") && !SPECIALIZED_FACULTY_GROUPS.has(label));
const GRADUATE_GROUPS = new Set(["Graduate Students", "Postdocs"]);
const NON_TEACHING_TOPICS = new Set([
  "Career Development",
  "Career Transitions",
  "Faculty Community",
  "Faculty Leadership",
  "Faculty Well-being",
  "Grant Writing",
  "Mentoring",
  "Onboarding",
  "Productivity",
  "Promotion & Tenure",
  "Research",
  "Shared Governance",
  "Strategy",
  "Undergraduate Research",
  "Workload",
  "Writing"
]);
const TEACHING_CONTEXT_TOPICS = new Set(["Teaching", "Curriculum"]);
const STRONG_MIXED_CONTEXT_TOPICS = new Set(
  [...NON_TEACHING_TOPICS].filter((topic) => topic !== "Mentoring")
);
const GENERAL_FACULTY_AUDIENCES = new Set([
  "all faculty",
  "all instructors",
  "all uri faculty",
  "all writers",
  "education faculty",
  "faculty",
  "research-active faculty"
]);

function normalizeAudience(value) {
  return String(value || "").trim().toLowerCase();
}

export function resolveAudienceGroups(item) {
  if (item.provider === "CIRTL") return new Set(GRADUATE_GROUPS);
  if (item.provider === "NCFDD") return new Set(AUDIENCE_GROUPS.map((group) => group.label));

  const audiences = (item.audience || []).map(normalizeAudience);
  const directGroups = new Set();

  AUDIENCE_GROUPS.forEach((group) => {
    const aliases = group.aliases.map(normalizeAudience);
    if (audiences.some((audience) => aliases.includes(audience))) {
      directGroups.add(group.label);
    }
  });

  const hasGeneralFacultyAudience = audiences.some((audience) => GENERAL_FACULTY_AUDIENCES.has(audience));
  const hasSpecificFacultyOrLeadershipAudience = [...directGroups].some((label) => !GRADUATE_GROUPS.has(label));

  if (hasGeneralFacultyAudience && !hasSpecificFacultyOrLeadershipAudience) {
    GENERAL_FACULTY_GROUPS.forEach((label) => directGroups.add(label));
    const topics = item.topics || [];
    const hasNonTeachingTopic = topics.some((topic) => NON_TEACHING_TOPICS.has(topic));
    const hasTeachingContext = topics.some((topic) => TEACHING_CONTEXT_TOPICS.has(topic));
    const hasStrongMixedContext = topics.some((topic) => STRONG_MIXED_CONTEXT_TOPICS.has(topic));
    if (hasNonTeachingTopic && (!hasTeachingContext || hasStrongMixedContext)) {
      SPECIALIZED_FACULTY_GROUPS.forEach((label) => directGroups.add(label));
    }
  }

  return directGroups;
}
