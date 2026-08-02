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
  const history = { runs: data.meta.updateHistory || [] };

  const snapshots = [];
  const discoveries = [];
  const providerChanges = [];
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
      const catalogTitles = source.catalogSync ? extractCatalogTitles(html) : [];

      snapshot.status = "ok";
      snapshot.title = title;
      snapshot.keywordsFound = keywordsFound;
      snapshot.detectedDates = detectedDates.slice(0, 8);
      snapshot.snippet = relevantSnippet(text, source.match || []);

      refreshKnownItems(data.trainings, source, today);
      if (source.catalogSync) {
        const reconciliation = reconcileCatalogItems(data.trainings, source, catalogTitles, today);
        discoveries.push(...reconciliation.discoveries);
        providerChanges.push({
          source: source.key,
          provider: source.provider,
          catalogItems: reconciliation.catalogItems,
          added: reconciliation.discoveries.map((item) => item.title),
          missing: reconciliation.missing,
          removed: reconciliation.removed,
          restored: reconciliation.restored
        });
      }
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

  const linkAudit = await auditKnownSourceLinks(data.trainings, snapshots, today);

  const merged = mergeDiscoveries(data.trainings, discoveries);
  data.trainings = merged.trainings;
  const beforeExpiration = new Map(data.trainings.map((item) => [item.id, item.status]));
  const expiration = reconcileExpiredItems(data.trainings, today);
  const archivedPast = data.trainings
    .filter((item) => beforeExpiration.get(item.id) !== "expired" && item.status === "expired")
    .map((item) => ({ id: item.id, title: item.title, provider: item.provider }));
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

  history.runs.push({
    ranAt: now.toISOString(),
    localDate: today,
    checkedSources: snapshots.length,
    successfulSources: snapshots.filter((snapshot) => snapshot.status === "ok").length,
    failedSources: snapshots.filter((snapshot) => snapshot.status === "error").map((snapshot) => ({
      key: snapshot.key,
      provider: snapshot.provider,
      error: snapshot.error
    })),
    added: discoveries.map((item) => ({ id: item.id, title: item.title, provider: item.provider })),
    providerChanges,
    archivedPast,
    linkAudit,
    providerCoverage: summarizeProviderCoverage(data.trainings, sources)
  });
  history.runs = history.runs.slice(-365);
  data.meta.updateHistory = history.runs;

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

export function reconcileCatalogItems(trainings, source, catalogTitles, today) {
  const sync = source.catalogSync || {};
  const prefix = sync.itemIdPrefix || source.itemIdPrefix;
  const threshold = Math.max(1, sync.missingRunsBeforeArchive || 2);
  const canonicalTitles = unique(catalogTitles.map((title) => source.catalogSync.titleAliases?.[title] || title));
  const titleMap = new Map(canonicalTitles.map((title) => [catalogTitleKey(title), title]));
  const managed = trainings.filter((item) => prefix && item.id.startsWith(prefix));
  const missing = [];
  const removed = [];
  const restored = [];

  for (const item of managed) {
    const present = titleMap.has(catalogTitleKey(item.title));
    if (present) {
      delete item.sourceMissingCount;
      delete item.sourceMissingSince;
      if (item.status === "source-removed" && item.statusBeforeSourceRemoval) {
        item.status = item.statusBeforeSourceRemoval;
        delete item.statusBeforeSourceRemoval;
        delete item.sourceRemovedAt;
        restored.push(item.title);
      }
      continue;
    }

    item.sourceMissingCount = (item.sourceMissingCount || 0) + 1;
    item.sourceMissingSince ||= today;
    missing.push(item.title);
    if (item.sourceMissingCount >= threshold && item.status !== "source-removed") {
      item.statusBeforeSourceRemoval = item.status;
      item.status = "source-removed";
      item.sourceRemovedAt = today;
      removed.push(item.title);
    }
  }

  const known = new Set(managed.map((item) => catalogTitleKey(item.title)));
  const discoveries = canonicalTitles
    .filter((title) => !known.has(catalogTitleKey(title)))
    .map((title) => catalogDiscovery(source, title, today));

  return { catalogItems: canonicalTitles.length, discoveries, missing, removed, restored };
}

function catalogDiscovery(source, title, today) {
  return {
    id: `detected-${slug(source.provider)}-${slug(title)}`,
    title,
    provider: source.provider,
    status: "discovered",
    priority: "review",
    startDate: today,
    endDate: today,
    dateLabel: "Newly detected on the provider catalog; date needs review",
    datePrecision: "placeholder",
    format: labelForSourceType(source.type),
    topics: inferTopics(title),
    audience: ["Faculty"],
    access: "Automatically detected from the provider catalog. Confirm access, cost, and registration details.",
    accessStatus: "confirm",
    costStatus: "membership-confirmation-needed",
    description: `New opportunity detected on ${source.label}.`,
    whyInclude: "Added by the overnight provider-catalog comparison.",
    sourceUrl: source.url,
    lastVerified: today,
    detectedByUpdater: true,
    catalogSource: source.key
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
    signal: AbortSignal.timeout(20000),
    headers: {
      "User-Agent": "URI-Faculty-Training-Updater/1.0",
      "Accept": "text/html,application/xhtml+xml,text/plain"
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function auditKnownSourceLinks(trainings, snapshots, today) {
  const snapshotStatus = new Map(snapshots.map((snapshot) => [snapshot.url, snapshot.status]));
  const urls = unique(trainings.map((item) => item.sourceUrl));
  const results = await mapWithConcurrency(urls, 6, async (url) => {
    if (snapshotStatus.get(url) === "ok") return { url, status: "ok", reusedSnapshot: true };
    try {
      await fetchText(url);
      return { url, status: "ok" };
    } catch (error) {
      const hardGone = /HTTP (404|410)\b/.test(error.message);
      return { url, status: hardGone ? "gone" : "error", error: error.message };
    }
  });
  const byUrl = new Map(results.map((result) => [result.url, result]));
  const removed = [];
  const restored = [];

  for (const item of trainings) {
    const result = byUrl.get(item.sourceUrl);
    if (!result) continue;
    if (result.status === "ok") {
      delete item.sourceLinkFailureCount;
      delete item.sourceLinkFailureSince;
      if (item.status === "source-removed" && item.statusBeforeSourceRemoval && !item.sourceMissingCount) {
        item.status = item.statusBeforeSourceRemoval;
        delete item.statusBeforeSourceRemoval;
        delete item.sourceRemovedAt;
        restored.push({ id: item.id, title: item.title, provider: item.provider });
      }
      continue;
    }
    if (result.status !== "gone") continue;
    item.sourceLinkFailureCount = (item.sourceLinkFailureCount || 0) + 1;
    item.sourceLinkFailureSince ||= today;
    if (item.sourceLinkFailureCount >= 2 && item.status !== "source-removed") {
      item.statusBeforeSourceRemoval = item.status;
      item.status = "source-removed";
      item.sourceRemovedAt = today;
      removed.push({ id: item.id, title: item.title, provider: item.provider, url: item.sourceUrl });
    }
  }

  return {
    checkedUrls: results.length,
    successfulUrls: results.filter((result) => result.status === "ok").length,
    goneUrls: results.filter((result) => result.status === "gone").map((result) => result.url),
    transientErrors: results.filter((result) => result.status === "error").map((result) => ({ url: result.url, error: result.error })),
    removed,
    restored
  };
}

function summarizeProviderCoverage(trainings, sources) {
  return unique(trainings.map((item) => item.provider)).sort().map((provider) => ({
    provider,
    activeRecords: trainings.filter((item) => item.provider === provider && !["expired", "source-removed"].includes(item.status)).length,
    configuredSources: sources.filter((source) => source.provider === provider).length,
    managedCatalogs: sources.filter((source) => source.provider === provider && source.catalogSync).length
  }));
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
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

export function extractCatalogTitles(html) {
  const strongText = [...html.matchAll(/<(?:p|td)[^>]*>\s*<strong[^>]*>(.*?)<\/strong>/gis)]
    .map((match) => normalizeText(stripHtml(match[1])))
    .map(cleanCatalogTitle)
    .filter(isCatalogTitle);
  return unique(strongText);
}

function cleanCatalogTitle(title) {
  return title
    .replace(/(\s*\((?:ALL|FTF|GTA|PTF|NF)\))+\s*$/i, "")
    .replace(/\s+Sessions?\s+#?[\d, &]+$/i, "")
    .trim();
}

function isCatalogTitle(title) {
  if (title.length < 5 || title.length > 180) return false;
  if (/^(dates?|times?|location|logistics|registration|additional dates?|additional dates?\/times?|program information)\b/i.test(title)) return false;
  if (/^(session|walking & talking|books will|while participation|registration for)/i.test(title)) return false;
  return !isNavigationLabel(title);
}

function catalogTitleKey(title) {
  return cleanCatalogTitle(title)
    .toLowerCase()
    .replace(/\b10th anniversary edition\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  return decodeEntities(text).replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
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
    .replace(/&mdash;/g, "-")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)));
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
