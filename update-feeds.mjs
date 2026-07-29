import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataPath = path.join(__dirname, "data", "trainings.json");
const sourcesPath = path.join(__dirname, "data", "sources.json");
const DISPLAY_TIME_ZONE = "America/New_York";
const EXPIRING_DATE_PRECISIONS = new Set(["exact", "detected"]);

const TOPIC_KEYWORDS = {
  AI: ["ai", "artificial intelligence", "generative ai", "chatgpt"],
  Writing: ["writing", "write", "manuscript", "publication"],
  "Promotion & Tenure": ["promotion", "tenure", "retention", "dossier"],
  Teaching: ["teaching", "pedagogy", "curriculum", "assessment"],
  Mentoring: ["mentor", "mentoring", "undergraduate research"],
  "Faculty Leadership": ["chair", "leader", "strategy", "department"]
};

export async function updateFeeds() {
  const data = JSON.parse(await fs.readFile(dataPath, "utf8"));
  const sources = JSON.parse(await fs.readFile(sourcesPath, "utf8")).sources.filter((source) => source.enabled);

  const snapshots = [];
  const discoveries = [];
  const now = new Date();
  const today = dateInTimeZone(now, DISPLAY_TIME_ZONE);

  for (const source of sources) {
    const snapshot = {
      key: source.key,
      provider: source.provider,
      label: source.label,
      url: source.url,
      lastFetched: now.toISOString(),
      status: "pending",
      keywordsFound: [],
      detectedDates: [],
      title: "",
      snippet: ""
    };

    try {
      const html = await fetchText(source.url);
      const text = normalizeText(stripHtml(html));
      const title = extractTitle(html) || source.label;
      const keywordsFound = findKeywords(text, source.match || []);
      const detectedDates = extractDates(text);
      const headings = extractHeadings(html);

      snapshot.status = "ok";
      snapshot.title = title;
      snapshot.keywordsFound = keywordsFound;
      snapshot.detectedDates = detectedDates.slice(0, 8);
      snapshot.snippet = relevantSnippet(text, source.match || []);

      refreshKnownItems(data.trainings, source, today);
      if (source.discover !== false) {
        discoveries.push(...discoverItems({ source, title, text, headings, detectedDates, today, trainings: data.trainings }));
      }
      refreshNcfddWritingChallenge(data.trainings, source, text, today);
    } catch (error) {
      snapshot.status = "error";
      snapshot.error = error.message;
    }

    snapshots.push(snapshot);
  }

  const merged = mergeDiscoveries(data.trainings, discoveries);
  data.trainings = merged.trainings;
  const expiration = reconcileExpiredItems(data.trainings, today);
  data.meta.lastUpdated = now.toISOString();
  data.meta.nextUpdateRecommended = addDays(now, 7).toISOString();
  data.meta.sourceSnapshots = snapshots;
  data.meta.updateSummary = {
    checkedSources: snapshots.length,
    successfulSources: snapshots.filter((snapshot) => snapshot.status === "ok").length,
    detectedItems: discoveries.length,
    addedDiscoveries: merged.added,
    updatedKnownItems: data.trainings.filter((item) => item.lastVerified === today).length,
    archivedPastItems: expiration.archived,
    restoredItems: expiration.restored
  };

  await fs.writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`);

  return {
    checkedSources: snapshots.length,
    successfulSources: snapshots.filter((snapshot) => snapshot.status === "ok").length,
    detectedItems: discoveries.length,
    addedDiscoveries: merged.added,
    archivedPastItems: expiration.archived,
    restoredItems: expiration.restored
  };
}

export function reconcileExpiredItems(trainings, today) {
  let archived = 0;
  let restored = 0;

  for (const item of trainings) {
    if (!isExpirationEligible(item)) continue;

    if (item.endDate < today && item.status !== "expired") {
      item.statusBeforeExpiry = item.status;
      item.status = "expired";
      item.expiredAt = today;
      archived += 1;
      continue;
    }

    if (item.endDate >= today && item.status === "expired" && item.statusBeforeExpiry) {
      item.status = item.statusBeforeExpiry;
      delete item.statusBeforeExpiry;
      delete item.expiredAt;
      restored += 1;
    }
  }

  return { archived, restored };
}

function isExpirationEligible(item) {
  return (
    item.keepAfterEnd !== true &&
    EXPIRING_DATE_PRECISIONS.has(item.datePrecision) &&
    isIsoDate(item.endDate)
  );
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "URI-Faculty-Training-Updater/1.0",
      "Accept": "text/html,application/xhtml+xml,text/plain"
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function refreshKnownItems(trainings, source, today) {
  for (const item of trainings) {
    const matchesPrefix = source.itemIdPrefix && item.id.startsWith(source.itemIdPrefix);
    if (matchesPrefix || item.sourceUrl === source.url || sameHost(item.sourceUrl, source.url)) {
      if (source.provider === item.provider || source.url === item.sourceUrl) {
        item.lastVerified = today;
      }
    }
  }
}

function refreshNcfddWritingChallenge(trainings, source, text, today) {
  if (source.key !== "ncfdd_writing_challenge") return;

  const sessionRegex = /([A-Za-z ]+Session):\s+([A-Za-z]+)\s+(\d{1,2})\s+-\s+([A-Za-z]+)\s+(\d{1,2}),\s+(20\d{2})/g;
  const matches = [...text.matchAll(sessionRegex)];
  for (const match of matches) {
    const [, label, startMonth, startDay, endMonth, endDay, year] = match;
    const startDate = dateFromParts(startMonth, startDay, year);
    const endDate = dateFromParts(endMonth, endDay, year);
    const normalized = `${label.trim()} ${year}`.toLowerCase();
    const existing = trainings.find((item) => item.provider === "NCFDD" && item.title.toLowerCase().includes("14-day writing challenge") && searchable(item).includes(normalized.split(" ")[0]));
    if (existing) {
      existing.startDate = startDate;
      existing.endDate = endDate;
      existing.dateLabel = `${startMonth} ${startDay}-${endMonth} ${endDay}, ${year}`;
      existing.lastVerified = today;
    }
  }
}

function discoverItems({ source, title, text, headings, detectedDates, today, trainings }) {
  if (source.type === "access-evidence") return [];
  if (trainings.some((item) => item.sourceUrl === source.url)) return [];

  const candidates = unique([title, ...headings])
    .map((candidate) => normalizeText(candidate))
    .filter((candidate) => candidate.length >= 12 && candidate.length <= 140)
    .filter((candidate) => !isNavigationLabel(candidate))
    .filter((candidate) => !shouldSkipDiscovery(candidate, source, trainings));

  const matched = candidates.filter((candidate) => {
    const haystack = `${candidate} ${text}`.toLowerCase();
    return Object.values(TOPIC_KEYWORDS).flat().some((keyword) => haystack.includes(keyword));
  });

  return matched.slice(0, 3).map((candidate, index) => {
    const topics = inferTopics(`${candidate} ${text}`);
    const id = `detected-${slug(source.provider)}-${slug(candidate)}-${index + 1}`;
    const date = detectedDates[0]?.iso || today;
    return {
      id,
      title: candidate,
      provider: source.provider,
      status: "discovered",
      priority: "review",
      startDate: date,
      endDate: date,
      dateLabel: detectedDates[0]?.label ? `Detected source date: ${detectedDates[0].label}` : "Newly detected; date needs review",
      datePrecision: "detected",
      format: labelForSourceType(source.type),
      topics,
      audience: ["Faculty"],
      access: "Automatically detected from a source page. Review access and cost.",
      accessStatus: "confirm",
      costStatus: "membership-confirmation-needed",
      description: relevantSnippet(text, source.match || Object.values(TOPIC_KEYWORDS).flat()),
      whyInclude: "Newly detected by the updater because the source page matched the calendar's priority topics.",
      sourceUrl: source.url,
      lastVerified: today,
      detectedByUpdater: true
    };
  });
}

function mergeDiscoveries(trainings, discoveries) {
  let added = 0;
  const byId = new Map(trainings.map((item) => [item.id, item]));
  const byTitleProvider = new Set(trainings.map((item) => `${item.provider}:${item.title}`.toLowerCase()));

  for (const discovery of discoveries) {
    const key = `${discovery.provider}:${discovery.title}`.toLowerCase();
    if (byId.has(discovery.id) || byTitleProvider.has(key)) continue;
    trainings.push(discovery);
    added += 1;
  }

  return { trainings, added };
}

function inferTopics(text) {
  const lower = text.toLowerCase();
  const topics = Object.entries(TOPIC_KEYWORDS)
    .filter(([, keywords]) => keywords.some((keyword) => lower.includes(keyword)))
    .map(([topic]) => topic);
  return topics.length ? topics : ["Faculty Development"];
}

function findKeywords(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.filter((keyword) => lower.includes(keyword.toLowerCase()));
}

function relevantSnippet(text, keywords) {
  const lower = text.toLowerCase();
  const index = keywords.map((keyword) => lower.indexOf(keyword.toLowerCase())).find((position) => position >= 0);
  const start = Math.max(0, (index >= 0 ? index : 0) - 140);
  const end = Math.min(text.length, start + 360);
  return text.slice(start, end).trim();
}

function extractTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return decodeEntities(og[1]);
  const h1 = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
  if (h1) return normalizeText(stripHtml(h1[1]));
  const title = html.match(/<title[^>]*>(.*?)<\/title>/is);
  if (title) return normalizeText(stripHtml(title[1]));
  return "";
}

function extractHeadings(html) {
  return [...html.matchAll(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gis)]
    .map((match) => normalizeText(stripHtml(match[1])))
    .filter(Boolean);
}

function extractDates(text) {
  const dateRegex = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+20\d{2}\b/g;
  return unique([...text.matchAll(dateRegex)].map((match) => match[0])).map((label) => ({
    label,
    iso: parseDateLabel(label)
  })).filter((date) => date.iso);
}

function parseDateLabel(label) {
  const date = new Date(label.replace(",", ""));
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function dateFromParts(month, day, year) {
  const date = new Date(`${month} ${day}, ${year}`);
  return date.toISOString().slice(0, 10);
}

function sameHost(left, right) {
  try {
    return new URL(left).host === new URL(right).host;
  } catch {
    return false;
  }
}

function searchable(item) {
  return `${item.title} ${item.dateLabel} ${item.description}`.toLowerCase();
}

function labelForSourceType(type) {
  const labels = {
    "event-index": "Detected event index",
    "event-page": "Detected event page",
    "archive-page": "Detected archive page",
    "resource-center": "Detected resource center",
    "resource-page": "Detected resource page"
  };
  return labels[type] || "Detected source";
}

function isNavigationLabel(text) {
  const lower = text.toLowerCase();
  const exactLabels = [
    "skip to main content",
    "contact us",
    "privacy notice",
    "menu close",
    "home",
    "about us",
    "upcoming events",
    "resources"
  ];
  const genericFragments = [
    "event views navigation",
    "events search and views navigation",
    "events and webinars archives",
    "events and webinars",
    "calendar",
    "browse by tag",
    "view events by date",
    "registration deadline"
  ];
  return exactLabels.some((label) => lower === label) || genericFragments.some((label) => lower.includes(label));
}

function shouldSkipDiscovery(candidate, source, trainings) {
  const lower = candidate.toLowerCase();
  if (/^(january|february|march|april|may|june|july|august|september|october|november|december)\s+20\d{2}$/.test(lower)) return true;
  if (lower.includes("deadline")) return true;
  if (source.key === "cur_calendar" && lower.includes("connectur")) {
    return trainings.some((item) => item.id === "cur-connectur-2026-hold");
  }
  return false;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function normalizeText(text) {
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "-");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  updateFeeds()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
