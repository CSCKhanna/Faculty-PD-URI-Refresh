export const AUDIENCE_GROUPS = [
  {
    label: "Graduate Students & Postdocs",
    aliases: ["Future faculty", "Graduate students", "Graduate teaching assistants", "Postdocs"]
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
    label: "Associate Deans",
    aliases: ["Associate deans"]
  },
  {
    label: "Department Chairs",
    aliases: ["Department chairs", "Chairs"]
  }
];

const FACULTY_GROUPS = AUDIENCE_GROUPS
  .map((group) => group.label)
  .filter((label) => label.endsWith("Faculty"));
const GRADUATE_GROUP = "Graduate Students & Postdocs";
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
  if (item.provider === "CIRTL") return new Set([GRADUATE_GROUP]);

  const audiences = (item.audience || []).map(normalizeAudience);
  const directGroups = new Set();

  AUDIENCE_GROUPS.forEach((group) => {
    const aliases = group.aliases.map(normalizeAudience);
    if (audiences.some((audience) => aliases.includes(audience))) {
      directGroups.add(group.label);
    }
  });

  const hasGeneralFacultyAudience = audiences.some((audience) => GENERAL_FACULTY_AUDIENCES.has(audience));
  const hasSpecificFacultyOrLeadershipAudience = [...directGroups].some((label) => label !== GRADUATE_GROUP);

  if (hasGeneralFacultyAudience && !hasSpecificFacultyOrLeadershipAudience) {
    FACULTY_GROUPS.forEach((label) => directGroups.add(label));
  }

  return directGroups;
}
