import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
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
  const previousSnapshots = new Map((data.meta.sourceSnapshots || []).map((snapshot) => [snapshot.key, snapshot]));

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
      const catalogItems = source.catalogSync
        ? extractCatalogItems(html, { ...source.catalogSync, baseUrl: source.url, referenceDate: today })
        : [];

      snapshot.status = "ok";
      snapshot.title = title;
      snapshot.keywordsFound = keywordsFound;
      snapshot.detectedDates = detectedDates.slice(0, 8);
      snapshot.snippet = relevantSnippet(text, source.match || []);
      snapshot.contentHash = createHash("sha256").update(text).digest("hex");
      snapshot.changed = Boolean(
        previousSnapshots.get(source.key)?.contentHash &&
        previousSnapshots.get(source.key).contentHash !== snapshot.contentHash
      );

      refreshKnownItems(data.trainings, source, today);
      if (source.catalogSync) {
        const reconciliation = reconcileCatalogItems(data.trainings, source, catalogItems, today);
        discoveries.push(...reconciliation.discoveries);
        providerChanges.push({
          source: source.key,
          provider: source.provider,
          status: reconciliation.status,
          reason: reconciliation.reason,
          catalogItems: reconciliation.catalogItems,
          added: reconciliation.discoveries.map((item) => item.title),
          missing: reconciliation.missing,
          removed: reconciliation.removed,
          restored: reconciliation.restored
        });
      }
      if (source.discover === true) {
        discoveries.push(...discoverItems({ source, title, text, headings, detectedDates, today, trainings: data.trainings }));
      }
      discoveries.push(...refreshNcfddWritingChallenge(data.trainings, source, text, today));
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
    added: merged.addedItems.map((item) => ({ id: item.id, title: item.title, provider: item.provider })),
    changedSources: snapshots.filter((snapshot) => snapshot.changed).map((snapshot) => ({
      key: snapshot.key,
      provider: snapshot.provider,
      label: snapshot.label
    })),
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

export function reconcileCatalogItems(trainings, source, catalogItems, today) {
  const sync = source.catalogSync || {};
  const prefix = sync.itemIdPrefix || source.itemIdPrefix;
  const threshold = Math.max(1, sync.missingRunsBeforeArchive || 2);
  const minimumItems = Math.max(1, sync.minimumItems || 1);
  const canonicalItems = uniqueCatalogItems(catalogItems.map((item) => {
    const normalized = typeof item === "string" ? { title: item } : item;
    return { ...normalized, title: sync.titleAliases?.[normalized.title] || normalized.title };
  }), sync.identityIncludesDate);
  if (canonicalItems.length < minimumItems) {
    return {
      status: "degraded",
      reason: `Extracted ${canonicalItems.length} catalog items; expected at least ${minimumItems}. No additions or removals were applied.`,
      catalogItems: canonicalItems.length,
      discoveries: [],
      missing: [],
      removed: [],
      restored: []
    };
  }
  const titleMap = new Map(canonicalItems.map((item) => [catalogItemKey(item, sync), item]));
  const managed = trainings.filter((item) => item.catalogSource === source.key || (prefix && item.id.startsWith(prefix)));
  const missing = [];
  const removed = [];
  const restored = [];

  for (const item of managed) {
    if (item.catalogSource === source.key && item.detectedByUpdater && !isCatalogTitle(item.title)) {
      if (item.status !== "source-removed") {
        item.statusBeforeSourceRemoval = item.status;
        item.status = "source-removed";
        item.sourceRemovedAt = today;
        item.sourceRemovalReason = "catalog-invalid";
        removed.push(item.title);
      }
      continue;
    }
    const present = titleMap.has(catalogItemKey(item, sync));
    if (present) {
      if (sync.refreshManagedFields) {
        refreshManagedCatalogItem(item, titleMap.get(catalogItemKey(item, sync)), source, today);
      }
      delete item.sourceMissingCount;
      delete item.sourceMissingSince;
      if (item.status === "source-removed" && item.statusBeforeSourceRemoval) {
        item.status = item.statusBeforeSourceRemoval;
        delete item.statusBeforeSourceRemoval;
        delete item.sourceRemovedAt;
        delete item.sourceRemovalReason;
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
      item.sourceRemovalReason = "catalog-missing";
      removed.push(item.title);
    }
  }

  const known = new Set(managed.map((item) => catalogItemKey(item, sync)));
  const discoveries = canonicalItems
    .filter((item) => !known.has(catalogItemKey(item, sync)))
    .map((item) => catalogDiscovery(source, item, today));

  return { status: "ok", catalogItems: canonicalItems.length, discoveries, missing, removed, restored };
}

function catalogDiscovery(source, item, today) {
  const { title } = item;
  const startDate = isoDatePart(item.startDate) || today;
  const endDate = isoDatePart(item.endDate) || startDate;
  const hasExactDates = Boolean(isoDatePart(item.startDate));
  return {
    id: `detected-${slug(source.provider)}-${slug(title)}${source.catalogSync?.identityIncludesDate && hasExactDates ? `-${startDate}` : ""}`,
    title,
    provider: source.provider,
    status: "discovered",
    priority: "standard",
    startDate,
    endDate,
    dateLabel: item.dateLabel || (hasExactDates ? formatCatalogDate(startDate, endDate) : "See the provider source for dates and registration"),
    datePrecision: hasExactDates ? "exact" : "placeholder",
    format: item.format || labelForSourceType(source.type),
    topics: inferTopics(`${title} ${item.description || ""}`),
    audience: source.catalogSync?.audience || ["Faculty"],
    access: source.catalogSync?.access || "Automatically published from the provider catalog. Check the source for access, cost, and registration details.",
    accessStatus: source.catalogSync?.accessStatus || "confirm",
    costStatus: source.catalogSync?.costStatus || "membership-confirmation-needed",
    description: item.description || `New opportunity detected on ${source.label}.`,
    whyInclude: "Automatically added by the overnight provider-catalog comparison.",
    sourceUrl: item.url || source.url,
    registrationUrl: item.registrationUrl,
    lastVerified: today,
    detectedByUpdater: true,
    catalogSource: source.key,
    catalogIdentityIncludesDate: source.catalogSync?.identityIncludesDate === true
  };
}

function refreshManagedCatalogItem(item, catalogItem, source, today) {
  const startDate = isoDatePart(catalogItem.startDate);
  const endDate = isoDatePart(catalogItem.endDate) || startDate;
  if (startDate) {
    item.startDate = startDate;
    item.endDate = endDate;
    item.datePrecision = "exact";
  }
  item.dateLabel = catalogItem.dateLabel || (startDate ? formatCatalogDate(startDate, endDate) : item.dateLabel);
  item.format = catalogItem.format || item.format;
  item.description = catalogItem.description || item.description;
  item.registrationUrl = catalogItem.registrationUrl || item.registrationUrl;
  item.sourceUrl = catalogItem.url || source.url;
  item.topics = inferTopics(`${catalogItem.title} ${catalogItem.description || ""}`);
  item.audience = source.catalogSync?.audience || item.audience;
  item.access = source.catalogSync?.access || item.access;
  item.accessStatus = source.catalogSync?.accessStatus || item.accessStatus;
  item.costStatus = source.catalogSync?.costStatus || item.costStatus;
  item.lastVerified = today;
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
      if (item.status === "source-removed" && item.statusBeforeSourceRemoval && item.sourceRemovalReason === "link-gone") {
        item.status = item.statusBeforeSourceRemoval;
        delete item.statusBeforeSourceRemoval;
        delete item.sourceRemovedAt;
        delete item.sourceRemovalReason;
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
      item.sourceRemovalReason = "link-gone";
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

export function refreshNcfddWritingChallenge(trainings, source, text, today) {
  if (source.key !== "ncfdd_writing_challenge") return [];

  repairLegacyWritingChallenge(trainings, today);
  const discoveries = [];
  const sessionRegex = /((?:Back to School|Fall|Spring|Summer)\s+(20\d{2})\s+Session):\s+([A-Za-z]+)\s+(\d{1,2})\s*-\s*([A-Za-z]+)\s+(\d{1,2}),\s*(20\d{2})/gi;
  const matches = [...text.matchAll(sessionRegex)];
  for (const match of matches) {
    const [, label, labelYear, startMonth, startDay, endMonth, endDay, dateYear] = match;
    const year = dateYear || labelYear;
    const season = label.replace(/\s+20\d{2}\s+Session$/i, "").replace(/Back to School/i, "Back-to-School");
    const startDate = dateFromParts(startMonth, startDay, year);
    const endDate = dateFromParts(endMonth, endDay, year);
    const title = `14-Day Writing Challenge: ${season} ${year} Session`;
    const existing = trainings.find((item) => {
      if (item.provider !== "NCFDD" || !item.title.toLowerCase().includes("14-day writing challenge")) return false;
      const itemSeason = item.title.toLowerCase().replace("back to school", "back-to-school");
      const idYear = item.id.match(/20\d{2}/)?.[0];
      return itemSeason.includes(season.toLowerCase()) && (!idYear || idYear === year) && (item.startDate || "").startsWith(year);
    });
    if (existing) {
      existing.startDate = startDate;
      existing.endDate = endDate;
      existing.dateLabel = `${startMonth} ${startDay}-${endMonth} ${endDay}, ${year}`;
      existing.datePrecision = "exact";
      existing.lastVerified = today;
      continue;
    }

    discoveries.push({
      id: `ncfdd-writing-challenge-${slug(season)}-${year}`,
      title,
      provider: "NCFDD",
      status: "discovered",
      priority: "standard",
      startDate,
      endDate,
      dateLabel: `${startMonth} ${startDay}-${endMonth} ${endDay}, ${year}`,
      datePrecision: "exact",
      format: "Online writing challenge",
      topics: ["Writing"],
      audience: ["Faculty", "Graduate Students", "Postdocs"],
      access: "Free program. Use the provider source to register.",
      accessStatus: "verified",
      costStatus: "free",
      description: "A free, structured two-week opportunity to build a consistent writing habit with accountability and community support.",
      whyInclude: "Automatically added from NCFDD's published Writing Challenge schedule.",
      sourceUrl: source.url,
      lastVerified: today,
      detectedByUpdater: true,
      catalogSource: source.key
    });
  }
  return discoveries;
}

function repairLegacyWritingChallenge(trainings, today) {
  const summer2026 = trainings.find((item) => item.id === "ncfdd-writing-challenge-july-2026");
  if (!summer2026 || (summer2026.startDate || "").startsWith("2026")) return;
  summer2026.startDate = "2026-07-06";
  summer2026.endDate = "2026-07-19";
  summer2026.dateLabel = "July 6-19, 2026";
  summer2026.datePrecision = "exact";
  if (summer2026.endDate < today) {
    summer2026.statusBeforeExpiry ||= summer2026.status === "expired" ? "recommended" : summer2026.status;
    summer2026.status = "expired";
    summer2026.expiredAt ||= today;
  }
}

function discoverItems({ source, title, text, headings, detectedDates, today, trainings }) {
  if (source.type === "access-evidence") return [];

  const candidates = unique([title, ...headings])
    .map((candidate) => normalizeText(candidate))
    .filter((candidate) => candidate.length >= 12 && candidate.length <= 140)
    .filter((candidate) => !isNavigationLabel(candidate))
    .filter((candidate) => !shouldSkipDiscovery(candidate, source, trainings));

  const discoveryKeywords = unique([...(source.match || []), ...Object.values(TOPIC_KEYWORDS).flat()]);
  const matched = candidates.filter((candidate) =>
    discoveryKeywords.some((keyword) => candidate.toLowerCase().includes(keyword.toLowerCase()))
  );

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
  const addedItems = [];
  const byId = new Map(trainings.map((item) => [item.id, item]));
  const discoveryKey = (item) => `${item.provider}:${item.title}${item.catalogIdentityIncludesDate && item.startDate ? `:${item.startDate}` : ""}`.toLowerCase();
  const byTitleProvider = new Set(trainings.map(discoveryKey));

  for (const discovery of discoveries) {
    const key = discoveryKey(discovery);
    if (byId.has(discovery.id) || byTitleProvider.has(key)) continue;
    trainings.push(discovery);
    byId.set(discovery.id, discovery);
    byTitleProvider.add(key);
    addedItems.push(discovery);
    added += 1;
  }

  return { trainings, added, addedItems };
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

export function extractCatalogTitles(html, options = {}) {
  return extractCatalogItems(html, options).map((item) => item.title);
}

export function extractCatalogItems(html, options = {}) {
  if (options.structuredDataEvents) return filterCatalogItems(extractStructuredEvents(html), options);
  if (options.curCalendarEvents) return filterCatalogItems(extractCurCalendarEvents(html, options.baseUrl), options);
  if (options.uriItsEvents) return filterCatalogItems(extractUriItsEvents(html, options), options);

  const headingLevels = (options.headingLevels || []).join("");
  const pattern = headingLevels
    ? new RegExp(`<h[${headingLevels}][^>]*>(.*?)<\\/h[${headingLevels}]>`, "gis")
    : /<(?:p|td)[^>]*>\s*<strong[^>]*>(.*?)<\/strong>/gis;
  const items = [...html.matchAll(pattern)].map((match) => ({
    title: cleanCatalogTitle(normalizeText(stripHtml(match[1]))),
    url: extractHref(match[1], options.baseUrl)
  }));
  return filterCatalogItems(items, options);
}

function filterCatalogItems(items, options) {
  const includePatterns = (options.includePatterns || []).map((value) => new RegExp(value, "i"));
  const excludePatterns = (options.excludePatterns || []).map((value) => new RegExp(value, "i"));
  const excludeContentPatterns = (options.excludeContentPatterns || []).map((value) => new RegExp(value, "i"));
  return uniqueCatalogItems(items
    .filter((item) => isCatalogTitle(item.title))
    .filter((item) => !includePatterns.length || includePatterns.some((rule) => rule.test(item.title)))
    .filter((item) => !excludePatterns.some((rule) => rule.test(item.title)))
    .filter((item) => !excludeContentPatterns.some((rule) => rule.test(`${item.title} ${item.description || ""}`))),
  options.identityIncludesDate);
}

function extractUriItsEvents(html, options) {
  const section = html.match(/Scheduled PD \(In-person and Virtual\)([\s\S]*?)Virtual Office Hours &amp; Drop-Ins/i)?.[1] || "";
  const events = [];
  for (const dayChunk of section.split(/<div class=["']calendar-day["']>/i).slice(1)) {
    const month = dayChunk.match(/class=["']month_of["'][^>]*>([^<]+)/i)?.[1]?.trim();
    const day = dayChunk.match(/class=["']day_of["'][^>]*>([^<]+)/i)?.[1]?.trim();
    const startDate = inferUriItsDate(month, day, options.referenceDate);
    for (const eventChunk of dayChunk.split(/<div class=["']calendar-event["']>/i).slice(1)) {
      const title = normalizeText(stripHtml(eventChunk.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i)?.[1] || ""));
      if (!title) continue;
      const startTime = normalizeText(stripHtml(eventChunk.match(/<span class=["']start["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || ""));
      const endTime = normalizeText(stripHtml(eventChunk.match(/<span class=["']end["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || ""));
      const detailsHtml = eventChunk.match(/<div class=["']type["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";
      const extractedDescription = normalizeText(stripHtml(detailsHtml));
      const description = /^(?:register|join zoom meeting)$/i.test(extractedDescription) ? "" : extractedDescription;
      const registrationUrl = extractRegistrationHref(detailsHtml, options.baseUrl);
      events.push({
        title,
        startDate,
        endDate: startDate,
        dateLabel: formatUriItsDate(startDate, startTime, endTime),
        format: registrationUrl?.includes("zoom.us") ? "Online; Zoom" : "See the URI ITS source for format",
        description: description || `URI ITS scheduled professional development on ${title}.`,
        registrationUrl,
        url: options.baseUrl
      });
    }
  }
  return events;
}

function inferUriItsDate(month, day, referenceDate) {
  if (!month || !day) return undefined;
  const reference = /^\d{4}-\d{2}-\d{2}$/.test(referenceDate || "")
    ? new Date(`${referenceDate}T12:00:00Z`)
    : new Date();
  let candidate = new Date(`${month} ${day}, ${reference.getUTCFullYear()} 12:00:00 UTC`);
  if (Number.isNaN(candidate.getTime())) return undefined;
  const daysBehind = (reference - candidate) / 86400000;
  if (daysBehind > 180) candidate = new Date(`${month} ${day}, ${reference.getUTCFullYear() + 1} 12:00:00 UTC`);
  return candidate.toISOString().slice(0, 10);
}

function formatUriItsDate(date, startTime, endTime) {
  if (!date) return "See the URI ITS source for date and registration";
  const label = new Intl.DateTimeFormat("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC"
  }).format(new Date(`${date}T12:00:00Z`));
  return startTime && endTime ? `${label}, ${startTime}-${endTime}` : label;
}

function extractRegistrationHref(fragment, baseUrl) {
  const match = [...fragment.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .find(([, , label]) => /register|join zoom/i.test(stripHtml(label)));
  if (!match) return undefined;
  try {
    return new URL(decodeEntities(match[1]), baseUrl).href;
  } catch {
    return undefined;
  }
}

function extractHref(fragment, baseUrl) {
  const href = fragment.match(/<a[^>]+href=["']([^"']+)["']/i)?.[1];
  if (!href) return undefined;
  try {
    return new URL(decodeEntities(href), baseUrl).href;
  } catch {
    return undefined;
  }
}

function extractCurCalendarEvents(html, baseUrl) {
  const events = [];
  const pattern = /<h3[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>\s*<\/h3>[\s\S]*?<div[^>]+class=["'][^"']*event-dates[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  for (const [, href, titleHtml, dateHtml] of html.matchAll(pattern)) {
    const dateText = normalizeText(stripHtml(dateHtml));
    const label = dateText.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+([A-Z][a-z]{2}\s+\d{1,2},\s+20\d{2})/)?.[1];
    events.push({
      title: normalizeText(stripHtml(titleHtml)),
      url: extractHref(`<a href="${href}"></a>`, baseUrl),
      startDate: label ? parseDateLabel(label) : undefined,
      endDate: label ? parseDateLabel(label) : undefined,
      format: "Provider event"
    });
  }
  return events;
}

function extractStructuredEvents(html) {
  const events = [];
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, raw] of scripts) {
    try {
      collectStructuredEvents(JSON.parse(raw), events);
    } catch {
      // A malformed JSON-LD block is ignored; catalog minimums still guard reconciliation.
    }
  }
  return uniqueCatalogItems(events);
}

function collectStructuredEvents(value, events) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectStructuredEvents(item, events));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value["@type"] === "Event" && value.name) {
    events.push({
      title: normalizeText(decodeEntities(value.name)),
      startDate: value.startDate,
      endDate: value.endDate,
      url: value.url,
      description: normalizeText(stripHtml(decodeEntities(value.description || ""))),
      format: value.location?.name || "Online"
    });
  }
  if (value["@graph"]) collectStructuredEvents(value["@graph"], events);
}

function uniqueCatalogItems(items, identityIncludesDate = false) {
  const byTitle = new Map();
  for (const item of items) {
    if (!item?.title) continue;
    const key = identityIncludesDate && isoDatePart(item.startDate)
      ? `${catalogTitleKey(item.title)}:${isoDatePart(item.startDate)}`
      : catalogTitleKey(item.title);
    if (!byTitle.has(key)) byTitle.set(key, item);
  }
  return [...byTitle.values()];
}

function isoDatePart(value) {
  const match = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] || "";
}

function formatCatalogDate(startDate, endDate) {
  const format = (value) => new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(`${value}T00:00:00Z`));
  return startDate === endDate ? format(startDate) : `${format(startDate)} - ${format(endDate)}`;
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
  if (/^(all sessions will\b|event type$)/i.test(title)) return false;
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

function catalogItemKey(item, sync = {}) {
  const title = catalogTitleKey(item.title);
  return sync.identityIncludesDate && isoDatePart(item.startDate) ? `${title}:${isoDatePart(item.startDate)}` : title;
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
