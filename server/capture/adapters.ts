import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import {
  feedEnvelopeSchema,
  opportunitySchema,
  sourceSchema,
  type OpportunityData,
  type SourceData,
} from "../../shared/capture";
import { publicFetch, SourceAccessError } from "./network";

const SAM_HOST = "api.sam.gov";
const TED_HOST = "api.ted.europa.eu";
const FTS_HOST = "www.find-tender.service.gov.uk";
const CONTRACTS_FINDER_HOST = "www.contractsfinder.service.gov.uk";
const CANADABUYS_HOST = "canadabuys.canada.ca";
const CANADABUYS_OPEN_TENDERS =
  "https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv";

const samCursorSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("sam"),
    from: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
    to: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
    offset: z.number().int().min(0).max(1_000_000),
  })
  .strict();
const tedCursorSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("ted"),
    from: z.string().regex(/^\d{8}$/),
    to: z.string().regex(/^\d{8}$/),
    token: z.string().min(1).max(8_000).optional(),
  })
  .strict();
const pageCursorSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["fts", "contracts-finder"]),
    url: z.string().max(2_000),
  })
  .strict();
const jsonCursorSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("json"),
    url: z.string().max(2_000),
    index: z.number().int().min(0).max(1_000_000),
    // A next URL starts at index zero, before its content can be hashed. A
    // resumed partial page always carries the hash that protects its index.
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
const snapshotCursorSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["canadabuys", "csv", "rss"]),
    offset: z.number().int().min(0).max(1_000_000),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

type PullResult = {
  opportunities: OpportunityData[];
  nextCursor: string | null;
  warnings: string[];
};
type UnknownRecord = Record<string, unknown>;

function text(value: unknown, max = 1_000_000): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().slice(0, max);
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function records(value: unknown): UnknownRecord[] {
  if (Array.isArray(value))
    return value.map(record).filter(item => Object.keys(item).length);
  const item = record(value);
  return Object.keys(item).length ? [item] : [];
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(strings);
  const item = text(value, 160);
  return item ? [item] : [];
}

function unique(values: string[], limit = 100): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const clean = text(value, 160);
    const key = clean.toLocaleLowerCase("en-US");
    if (clean && !seen.has(key)) {
      seen.add(key);
      result.push(clean);
      if (result.length === limit) break;
    }
  }
  return result;
}

function splitTags(value: unknown): string[] {
  return unique(
    strings(value).flatMap(item =>
      item.split(/[;,|\n]/).map(part => part.trim())
    )
  );
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function dateOnly(value: unknown): string {
  const source = text(value, 100);
  const iso = source.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso && validDate(iso[1])) return iso[1];
  const mdy = source.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (mdy) {
    const candidate = `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
    if (validDate(candidate)) return candidate;
  }
  return "";
}

function isoNow(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() - days);
  return now.toISOString().slice(0, 10);
}

function mdy(date: string): string {
  const [year, month, day] = date.split("-");
  return `${month}/${day}/${year}`;
}

function yyyymmdd(date: string): string {
  return date.replaceAll("-", "");
}

function validMoney(value: unknown): string | null {
  const candidate = text(value, 40).replaceAll(",", "");
  return /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(candidate) ? candidate : null;
}

function currency(value: unknown): OpportunityData["currency"] {
  const candidate = text(value, 12).toUpperCase();
  return ["USD", "EUR", "GBP", "CAD", "AUD"].includes(candidate)
    ? (candidate as OpportunityData["currency"])
    : "Unknown";
}

function hasAuthQuery(url: URL): boolean {
  const credentialNames = new Set([
    "api_key",
    "apikey",
    "key",
    "token",
    "access_token",
    "auth",
    "authorization",
    "signature",
    "sig",
  ]);
  return [...url.searchParams.keys()].some(name =>
    credentialNames.has(name.toLowerCase())
  );
}

function externalUrl(value: unknown, base?: URL): string {
  const raw = text(value, 2_000);
  if (!raw) return "";
  try {
    const url = base ? new URL(raw, base) : new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      hasAuthQuery(url)
    ) {
      return "";
    }
    return url.toString().slice(0, 2_000);
  } catch {
    return "";
  }
}

/** Extract only public HTTPS attachment links; this helper never requests them. */
export function extractAttachments(
  value: unknown,
  fallbackName = "Source document"
): OpportunityData["attachments"] {
  const candidates = strings(value).flatMap(item => {
    const matches = item.match(/https:\/\/[^\s<>"']+/gi);
    return matches?.length ? matches : [item];
  });
  const seen = new Set<string>();
  const attachments: OpportunityData["attachments"] = [];
  for (const candidate of candidates) {
    const url = externalUrl(candidate);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    attachments.push({
      name: text(fallbackName, 300) || "Source document",
      url,
    });
    if (attachments.length === 100) break;
  }
  return attachments;
}

function documentsToAttachments(
  value: unknown
): OpportunityData["attachments"] {
  const attachments: OpportunityData["attachments"] = [];
  for (const item of records(value)) {
    const label =
      text(
        item.description || item.title || item.documentType || item.id,
        300
      ) || "Notice document";
    attachments.push(...extractAttachments(item.url, label));
    if (attachments.length >= 100) return attachments.slice(0, 100);
  }
  return attachments;
}

function appendAttachments(
  ...groups: OpportunityData["attachments"][]
): OpportunityData["attachments"] {
  const seen = new Set<string>();
  const result: OpportunityData["attachments"] = [];
  for (const group of groups) {
    for (const attachment of group) {
      if (!attachment.url || seen.has(attachment.url)) continue;
      seen.add(attachment.url);
      result.push(attachment);
      if (result.length === 100) return result;
    }
  }
  return result;
}

function typeFromText(value: unknown): OpportunityData["type"] {
  const source = text(value, 1_000).toLocaleLowerCase("en-US");
  if (/sources?\s+sought/.test(source)) return "Sources sought";
  if (
    /request\s+for\s+information|\brfi\b|pre-market\s+consultation|\bpmc\b/.test(
      source
    )
  )
    return "RFI";
  if (
    /request\s+for\s+proposal|\brfp\b|solicitation|combined\s+synopsis|contract\s+notice|competition\s+notice/.test(
      source
    )
  ) {
    return "RFP";
  }
  return "Other";
}

function statusFromText(
  value: unknown,
  fallback: OpportunityData["noticeStatus"] = "Closed"
): OpportunityData["noticeStatus"] {
  const source = text(value, 1_000).toLocaleLowerCase("en-US");
  if (/cancel|withdraw|annul/.test(source)) return "Cancelled";
  if (/award|contract\s+award|result/.test(source)) return "Award";
  if (/open|active|published/.test(source)) return "Open";
  if (/close|expired|complete|inactive/.test(source)) return "Closed";
  return fallback;
}

function titleMatches(source: SourceData, title: string): boolean {
  const terms = source.keywords
    .split(/[,;\n]/)
    .map(item => item.trim().toLocaleLowerCase("en-US"))
    .filter(Boolean);
  if (!terms.length) return true;
  const candidate = title.toLocaleLowerCase("en-US");
  return terms.some(term => candidate.includes(term));
}

function uniqueAttachmentNames(
  attachments: OpportunityData["attachments"]
): OpportunityData["attachments"] {
  const names = new Set<string>(),
    urls = new Set<string>();
  return attachments.flatMap(item => {
    if (!item.url || urls.has(item.url)) return [];
    urls.add(item.url);
    let name = item.name.slice(0, 280),
      n = 1;
    const base = name;
    while (
      names.has(
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim()
      )
    ) {
      name = base + " (" + ++n + ")";
    }
    names.add(
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
    );
    return [{ name, url: item.url }];
  });
}
function finalize(candidate: Partial<OpportunityData>): OpportunityData | null {
  const parsed = opportunitySchema.safeParse({
    externalId: text(candidate.externalId, 300),
    title: text(candidate.title, 500),
    buyer: text(candidate.buyer, 200),
    country: text(candidate.country, 200),
    type: candidate.type ?? "Other",
    noticeStatus: candidate.noticeStatus ?? "Closed",
    solicitationId: text(candidate.solicitationId, 200),
    url: text(candidate.url, 2_000),
    postedAt: text(candidate.postedAt, 80),
    dueDate: dateOnly(candidate.dueDate),
    description: text(candidate.description, 1_000_000),
    naics: unique(candidate.naics ?? []),
    cpv: unique(candidate.cpv ?? []),
    geographies: unique(candidate.geographies ?? []),
    capabilities: unique(candidate.capabilities ?? []),
    value: validMoney(candidate.value),
    currency: currency(candidate.currency),
    requiredStatuses: unique(candidate.requiredStatuses ?? []),
    requiredCertifications: unique(candidate.requiredCertifications ?? []),
    // Source metadata and notice summaries are never an eligibility review.
    eligibilityReviewed: false,
    eligibilityNotes: text(candidate.eligibilityNotes, 10_000),
    documents: (candidate.documents ?? []).slice(0, 40),
    attachments: uniqueAttachmentNames(
      appendAttachments(candidate.attachments ?? [])
    ),
  });
  return parsed.success ? parsed.data : null;
}

function addCandidate(
  source: SourceData,
  candidate: Partial<OpportunityData>,
  opportunities: OpportunityData[],
  warnings: string[]
): void {
  if (
    opportunities.length >= source.maxItems ||
    !titleMatches(source, text(candidate.title, 500))
  )
    return;
  const parsed = finalize(candidate);
  if (!parsed) {
    if (
      !warnings.includes(
        "One or more source records did not contain the required notice metadata."
      )
    ) {
      warnings.push(
        "One or more source records did not contain the required notice metadata."
      );
    }
    return;
  }
  opportunities.push(parsed);
}

function parseCursor<T>(
  cursor: string | null | undefined,
  schema: z.ZodType<T>
): T | null {
  if (!cursor) return null;
  try {
    const decoded = schema.safeParse(JSON.parse(cursor));
    if (decoded.success) return decoded.data;
  } catch {
    // Cursor data is treated as untrusted persistent input.
  }
  throw new SourceAccessError(
    "INVALID_CURSOR",
    "The saved source cursor is invalid."
  );
}

function makeCursor(value: object): string {
  return JSON.stringify(value);
}

function contentHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotOffset(
  cursor: string | null | undefined,
  kind: "canadabuys" | "csv" | "rss",
  hash: string
): number {
  const saved = parseCursor(cursor, snapshotCursorSchema);
  if (!saved) return 0;
  if (saved.kind !== kind)
    throw new SourceAccessError(
      "INVALID_CURSOR",
      "The saved source cursor is invalid."
    );
  // Snapshot feeds have no stable upstream page token. If a publisher changes
  // the snapshot, start from the new first record rather than applying a stale
  // offset and silently dropping the changed records.
  return saved.contentHash === hash ? saved.offset : 0;
}

function snapshotCursor(
  kind: "canadabuys" | "csv" | "rss",
  offset: number,
  hash: string,
  hasRemaining: boolean
): string | null {
  return hasRemaining
    ? makeCursor({ version: 1, kind, offset, contentHash: hash })
    : null;
}

function sourceData(source: SourceData): SourceData {
  const parsed = sourceSchema.safeParse(source);
  if (!parsed.success)
    throw new SourceAccessError(
      "INVALID_SOURCE",
      "The source configuration is invalid."
    );
  return parsed.data;
}

function objectJson(value: unknown): UnknownRecord {
  const result = record(value);
  if (!Object.keys(result).length)
    throw new SourceAccessError(
      "INVALID_RESPONSE",
      "The source returned an invalid response."
    );
  return result;
}

function validSameOriginPage(
  value: unknown,
  base: URL,
  requiredPath: string,
  allowedHost: string
): string | null {
  const raw =
    typeof value === "string"
      ? value
      : text(record(value).href || record(value).url, 2_000);
  if (!raw) return null;
  try {
    const url = new URL(raw, base);
    if (
      url.protocol !== "https:" ||
      url.hostname !== allowedHost ||
      url.origin !== base.origin ||
      url.pathname !== requiredPath ||
      url.username ||
      url.password ||
      hasAuthQuery(url)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function initialSamCursor(source: SourceData) {
  return {
    from: mdy(daysAgo(source.lookbackDays)),
    to: mdy(isoNow()),
    offset: 0,
  };
}

async function samDescription(value: unknown, apiKey: string): Promise<string> {
  const raw = text(value, 2_000);
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== SAM_HOST ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    return "";
  }
  url.searchParams.delete("api_key");
  url.searchParams.set("api_key", apiKey);
  const response = await publicFetch(url, { allowedHosts: [SAM_HOST] });
  return (await response.text()).slice(0, 1_000_000);
}

function samStatus(notice: UnknownRecord): OpportunityData["noticeStatus"] {
  const type = `${text(notice.type)} ${text(notice.baseType)} ${text(notice.archiveType)}`;
  const direct = statusFromText(
    type,
    notice.active === true ? "Open" : "Closed"
  );
  return direct;
}

async function pullSam(
  source: SourceData,
  cursor?: string | null
): Promise<PullResult> {
  const apiKey = process.env.SAM_API_KEY?.trim();
  if (!apiKey) {
    throw new SourceAccessError(
      "SAM_API_KEY_REQUIRED",
      "SAM.gov API access is not configured."
    );
  }
  const saved = parseCursor(cursor, samCursorSchema);
  const window = saved ?? initialSamCursor(source);
  const search = new URL("https://api.sam.gov/opportunities/v2/search");
  search.searchParams.set("api_key", apiKey);
  search.searchParams.set("postedFrom", window.from);
  search.searchParams.set("postedTo", window.to);
  search.searchParams.set("limit", String(source.maxItems));
  search.searchParams.set("offset", String(window.offset));
  if (source.keywords) search.searchParams.set("title", source.keywords);

  const payload = objectJson(
    await (await publicFetch(search, { allowedHosts: [SAM_HOST] })).json()
  );
  const notices = records(
    payload.opportunitiesData || payload.opportunities || payload.opportunity
  );
  const opportunities: OpportunityData[] = [];
  const warnings: string[] = [];
  for (const notice of notices.slice(0, source.maxItems)) {
    const noticeId = text(notice.noticeId || notice.id, 300);
    const title = text(notice.title, 500);
    if (!noticeId || !title || !titleMatches(source, title)) {
      if (!noticeId || !title)
        warnings.push("One or more SAM notices lacked an identifier or title.");
      continue;
    }
    let description = text(
      notice.descriptionText || notice.description,
      1_000_000
    );
    if (text(notice.description, 2_000).startsWith("https://")) {
      try {
        description = await samDescription(notice.description, apiKey);
      } catch {
        description = "";
        if (
          !warnings.includes(
            "One or more SAM notice descriptions could not be read."
          )
        ) {
          warnings.push(
            "One or more SAM notice descriptions could not be read."
          );
        }
      }
    }
    const place = record(notice.placeOfPerformance);
    const address = record(notice.officeAddress);
    addCandidate(
      source,
      {
        externalId: noticeId,
        title,
        buyer: text(
          notice.fullParentPathName ||
            notice.organizationName ||
            notice.department,
          200
        ),
        country: "United States",
        type: typeFromText(`${text(notice.type)} ${text(notice.baseType)}`),
        noticeStatus: samStatus(notice),
        solicitationId: text(notice.solicitationNumber, 200),
        url: externalUrl(notice.uiLink || notice.additionalInfoLink),
        postedAt: text(notice.postedDate, 80),
        dueDate: text(notice.responseDeadLine || notice.reponseDeadLine, 100),
        description,
        naics: splitTags(notice.naicsCode),
        geographies: unique([
          text(
            record(place.state).code ||
              place.state ||
              record(place.city).name ||
              place.city,
            160
          ),
          text(address.city, 160),
        ]),
        capabilities: splitTags(notice.classificationCode),
        value: validMoney(
          record(notice.award).amount ||
            record(record(notice.data).award).amount
        ),
        currency: currency(
          record(notice.award).currency ||
            record(record(notice.data).award).currency
        ),
        eligibilityNotes:
          "Imported from SAM.gov metadata; mandatory eligibility was not reviewed.",
        attachments: appendAttachments(
          extractAttachments(notice.resourceLinks, "SAM notice attachment")
        ),
      },
      opportunities,
      warnings
    );
  }
  const total = Number(payload.totalRecords);
  const nextCursor =
    Number.isFinite(total) && total > window.offset + notices.length
      ? makeCursor({
          version: 1,
          kind: "sam",
          from: window.from,
          to: window.to,
          offset: window.offset + notices.length,
        })
      : null;
  return { opportunities, nextCursor, warnings: unique(warnings, 20) };
}

function i18n(value: unknown): string {
  if (typeof value === "string" || typeof value === "number")
    return text(value);
  if (Array.isArray(value)) return value.map(i18n).find(Boolean) || "";
  const item = record(value);
  for (const preferred of ["eng", "en", "fra", "fr", "deu", "de"]) {
    const selected = i18n(item[preferred]);
    if (selected) return selected;
  }
  for (const selected of Object.values(item)) {
    const result = i18n(selected);
    if (result) return result;
  }
  return "";
}

function tedType(notice: UnknownRecord): OpportunityData["type"] {
  const noticeType = `${text(notice["notice-type"])} ${text(notice["notice-subtype"])} ${text(notice["form-type"])}`;
  if (
    /\bpmc\b|pre-market\s+consultation|request\s+for\s+information/.test(
      noticeType.toLowerCase()
    )
  )
    return "RFI";
  // A planning/PIN publication is not automatically an RFI or a solicitation.
  if (/\bpin\b|planning|prior information/.test(noticeType.toLowerCase()))
    return "Other";
  if (
    /contract\s+notice|competition\s+notice|\bcn\b/.test(
      noticeType.toLowerCase()
    )
  )
    return "RFP";
  return "Other";
}

function tedStatus(notice: UnknownRecord): OpportunityData["noticeStatus"] {
  const noticeType = `${text(notice["notice-type"])} ${text(notice["notice-subtype"])} ${text(notice["form-type"])}`;
  const lower = noticeType.toLowerCase();
  if (/cancel|withdraw|annul/.test(lower)) return "Cancelled";
  if (/award|result|\bcan\b/.test(lower)) return "Award";
  if (/completion|change|modification|corrigendum/.test(lower)) return "Closed";
  const deadline = dateOnly(
    notice["deadline-receipt-tender-date-lot"] ||
      notice["deadline-receipt-request"]
  );
  return deadline && deadline < isoNow() ? "Closed" : "Open";
}

function tedLinks(value: unknown): OpportunityData["attachments"] {
  const links = record(value);
  const entries = Object.entries(links).flatMap(([kind, link]) =>
    strings(link).map(url => ({ kind, url }))
  );
  return entries.flatMap(entry =>
    extractAttachments(entry.url, `TED ${entry.kind}`)
  );
}

async function pullTed(
  source: SourceData,
  cursor?: string | null
): Promise<PullResult> {
  const saved = parseCursor(cursor, tedCursorSchema);
  const from = saved?.from ?? yyyymmdd(daysAgo(source.lookbackDays));
  const to = saved?.to ?? yyyymmdd(isoNow());
  const fields = [
    "publication-number",
    "notice-identifier",
    "notice-type",
    "notice-subtype",
    "form-type",
    "title-proc",
    "organisation-name-buyer",
    "organisation-country-buyer",
    "main-classification-proc",
    "additional-classification-proc",
    "deadline-receipt-tender-date-lot",
    "publication-date",
    "estimated-value-proc",
    "estimated-value-cur-proc",
  ];
  const payload = objectJson(
    await (
      await publicFetch("https://api.ted.europa.eu/v3/notices/search", {
        method: "POST",
        headers: { accept: "application/json" },
        jsonBody: {
          query: `publication-date >= ${from} AND publication-date <= ${to}`,
          fields,
          paginationMode: "ITERATION",
          limit: source.maxItems,
          scope: "LATEST",
          onlyLatestVersions: true,
          ...(saved?.token ? { iterationNextToken: saved.token } : {}),
        },
        allowedHosts: [TED_HOST],
      })
    ).json()
  );
  const opportunities: OpportunityData[] = [];
  const warnings: string[] = [];
  const notices = records(payload.notices);
  for (const notice of notices.slice(0, source.maxItems)) {
    const title = i18n(notice["title-proc"] || notice["notice-title"]);
    const publication = text(
      notice["publication-number"] || notice["notice-identifier"],
      300
    );
    if (!title || !publication) {
      warnings.push(
        "One or more TED notices lacked a publication number or title."
      );
      continue;
    }
    const classifications = unique([
      ...strings(notice["main-classification-proc"]),
      ...strings(notice["additional-classification-proc"]),
    ]);
    const buyer = i18n(notice["organisation-name-buyer"]);
    const country =
      strings(notice["organisation-country-buyer"])[0] ||
      source.country ||
      "European Union";
    addCandidate(
      source,
      {
        externalId: publication,
        title,
        buyer,
        country,
        type: tedType(notice),
        noticeStatus: tedStatus(notice),
        solicitationId: text(notice["notice-identifier"], 200),
        url: externalUrl(record(notice.links).html || record(notice.links).xml),
        postedAt: text(notice["publication-date"], 80),
        dueDate: text(
          notice["deadline-receipt-tender-date-lot"] ||
            notice["deadline-receipt-request"],
          100
        ),
        description: "",
        cpv: classifications,
        value: validMoney(notice["estimated-value-proc"]),
        currency: currency(notice["estimated-value-cur-proc"]),
        eligibilityNotes:
          "Imported from TED notice metadata; mandatory eligibility was not reviewed.",
        attachments: tedLinks(notice.links),
      },
      opportunities,
      warnings
    );
  }
  const token = text(payload.iterationNextToken, 8_000);
  return {
    opportunities,
    // TED can send an iteration token with an empty result set. Continuing it
    // would schedule an empty-page loop; only persist a token after a real
    // provider record was received.
    nextCursor:
      notices.length && token
        ? makeCursor({ version: 1, kind: "ted", from, to, token })
        : null,
    warnings: unique(warnings, 20),
  };
}

function releaseDate(release: UnknownRecord): number {
  const tender = record(release.tender);
  const candidates = [release.date, tender.dateModified, tender.datePublished];
  for (const value of candidates) {
    const parsed = Date.parse(text(value, 80));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function newestReleases(value: unknown): UnknownRecord[] {
  const latest = new Map<string, UnknownRecord>();
  for (const release of records(value)) {
    const ocid = text(release.ocid, 300);
    if (!ocid) continue;
    const current = latest.get(ocid);
    if (!current || releaseDate(release) >= releaseDate(current))
      latest.set(ocid, release);
  }
  return [...latest.values()];
}

function buyerName(release: UnknownRecord): string {
  const buyer = record(release.buyer);
  const direct = text(buyer.name, 200);
  if (direct) return direct;
  const buyerId = text(buyer.id, 200);
  for (const party of records(release.parties)) {
    const roles = strings(party.roles).map(role => role.toLowerCase());
    if ((buyerId && text(party.id, 200) === buyerId) || roles.includes("buyer"))
      return text(party.name, 200);
  }
  return "";
}

function ocdsClassifications(tender: UnknownRecord): string[] {
  const ids = [
    text(record(tender.classification).id, 160),
    ...records(tender.additionalClassifications).map(item =>
      text(item.id, 160)
    ),
    ...records(tender.items).map(item =>
      text(record(item.classification).id, 160)
    ),
  ];
  return unique(ids);
}

function ocdsGeographies(tender: UnknownRecord): string[] {
  const addresses = [
    ...records(tender.deliveryAddresses),
    ...records(tender.items).flatMap(item => records(item.deliveryAddresses)),
  ];
  return unique(
    addresses.flatMap(address => [
      text(address.countryName || address.country, 160),
      text(address.region, 160),
      text(address.locality, 160),
    ])
  );
}

function ocdsType(
  release: UnknownRecord,
  tender: UnknownRecord
): OpportunityData["type"] {
  const tags = strings(release.tag).map(tag => tag.toLowerCase());
  const noticeTypes = records(tender.documents)
    .map(document => text(document.noticeType, 160))
    .join(" ");
  const described = `${noticeTypes} ${text(tender.title)} ${text(tender.description)}`;
  const direct = typeFromText(described);
  if (direct !== "Other") return direct;
  // Planning releases are intentionally not classified as RFI merely because they
  // describe a future procurement. Award-only releases are not classified as RFPs.
  if (
    tags.includes("planning") ||
    tags.includes("award") ||
    tags.includes("implementation")
  )
    return "Other";
  return tags.includes("tender") ? "RFP" : "Other";
}

function ocdsStatus(
  release: UnknownRecord,
  tender: UnknownRecord
): OpportunityData["noticeStatus"] {
  const tags = strings(release.tag).map(tag => tag.toLowerCase());
  if (tags.includes("award") || records(release.awards).length) return "Award";
  const raw =
    `${text(tender.status)} ${strings(release.tag).join(" ")}`.toLowerCase();
  if (/cancel|withdraw/.test(raw)) return "Cancelled";
  if (/active|planned/.test(raw)) return "Open";
  if (/complete|closed|unsuccessful|implementation/.test(raw)) return "Closed";
  return "Closed";
}

function mapOcdsRelease(
  release: UnknownRecord,
  country: string
): Partial<OpportunityData> {
  const tender = record(release.tender);
  const planning = record(release.planning);
  const noticeDocuments = appendAttachments(
    documentsToAttachments(tender.documents),
    documentsToAttachments(planning.documents)
  );
  const firstDocument = noticeDocuments[0]?.url || "";
  const value = record(tender.value);
  return {
    externalId: text(release.ocid, 300),
    title: text(tender.title, 500),
    buyer: buyerName(release),
    country,
    type: ocdsType(release, tender),
    noticeStatus: ocdsStatus(release, tender),
    // Keep the immutable release/change identifier while deduplicating the
    // opportunity itself by OCID.
    solicitationId: text(release.id, 200),
    url: externalUrl(firstDocument || release.uri),
    postedAt: text(release.date || tender.datePublished, 80),
    dueDate: text(record(tender.tenderPeriod).endDate, 100),
    description: text(tender.description, 1_000_000),
    cpv: ocdsClassifications(tender),
    geographies: ocdsGeographies(tender),
    value: validMoney(value.amount || record(tender.minValue).amount),
    currency: currency(value.currency || record(tender.minValue).currency),
    eligibilityNotes:
      "Imported from an OCDS release; mandatory eligibility was not reviewed.",
    attachments: noticeDocuments,
  };
}

function pageUrlFromCursor(
  cursor: string | null | undefined,
  expectedKind: "fts" | "contracts-finder",
  initial: URL,
  expectedHost: string,
  expectedPath: string
): URL {
  const saved = parseCursor(cursor, pageCursorSchema);
  if (!saved) return initial;
  if (saved.kind !== expectedKind)
    throw new SourceAccessError(
      "INVALID_CURSOR",
      "The saved source cursor is invalid."
    );
  const checked = validSameOriginPage(
    saved.url,
    initial,
    expectedPath,
    expectedHost
  );
  if (!checked)
    throw new SourceAccessError(
      "INVALID_CURSOR",
      "The saved source cursor is invalid."
    );
  return new URL(checked);
}

async function pullOcds(
  source: SourceData,
  cursor: string | null | undefined,
  config: {
    kind: "fts" | "contracts-finder";
    host: string;
    path: string;
    country: string;
    initial: () => URL;
  }
): Promise<PullResult> {
  const initial = config.initial();
  const page = pageUrlFromCursor(
    cursor,
    config.kind,
    initial,
    config.host,
    config.path
  );
  const payload = objectJson(
    await (await publicFetch(page, { allowedHosts: [config.host] })).json()
  );
  const next = validSameOriginPage(
    record(payload.links).next,
    page,
    config.path,
    config.host
  );
  const opportunities: OpportunityData[] = [];
  const warnings: string[] = [];
  for (const release of newestReleases(payload.releases)) {
    addCandidate(
      source,
      mapOcdsRelease(release, config.country),
      opportunities,
      warnings
    );
  }
  return {
    opportunities,
    nextCursor: next
      ? makeCursor({ version: 1, kind: config.kind, url: next })
      : null,
    warnings,
  };
}

async function pullFindTender(
  source: SourceData,
  cursor?: string | null
): Promise<PullResult> {
  return pullOcds(source, cursor, {
    kind: "fts",
    host: FTS_HOST,
    path: "/api/1.0/ocdsReleasePackages",
    country: "United Kingdom",
    initial: () => {
      const url = new URL(`https://${FTS_HOST}/api/1.0/ocdsReleasePackages`);
      const now = new Date();
      const from = new Date(now.getTime());
      from.setUTCDate(from.getUTCDate() - source.lookbackDays);
      url.searchParams.set("limit", String(source.maxItems));
      url.searchParams.set("updatedFrom", from.toISOString().slice(0, 19));
      url.searchParams.set("updatedTo", now.toISOString().slice(0, 19));
      url.searchParams.set("stages", "planning,tender,award");
      return url;
    },
  });
}

async function pullContractsFinder(
  source: SourceData,
  cursor?: string | null
): Promise<PullResult> {
  return pullOcds(source, cursor, {
    kind: "contracts-finder",
    host: CONTRACTS_FINDER_HOST,
    path: "/Published/Notices/OCDS/Search",
    country: "United Kingdom",
    initial: () => {
      const url = new URL(
        `https://${CONTRACTS_FINDER_HOST}/Published/Notices/OCDS/Search`
      );
      url.searchParams.set("limit", String(source.maxItems));
      url.searchParams.set(
        "publishedFrom",
        `${daysAgo(source.lookbackDays)}T00:00:00`
      );
      url.searchParams.set("publishedTo", `${isoNow()}T23:59:59`);
      url.searchParams.set("stages", "planning,tender,award,implementation");
      return url;
    },
  });
}

/** RFC 4180-style parser supporting quoted commas, escaped quotes and newlines. */
export function parseCsv(input: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const value = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      if (char === '"') {
        if (value[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && value[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some(cell => cell.length)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some(cell => cell.length)) rows.push(row);
  const [headers, ...data] = rows;
  if (!headers?.length) return [];
  return data.map(values => {
    const item: Record<string, string> = {};
    headers.forEach((header, index) => {
      const key = header.trim();
      if (key && !(key in item)) item[key] = values[index] ?? "";
    });
    return item;
  });
}

function column(row: Record<string, string>, names: string[]): string {
  const direct = new Map(
    Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])
  );
  for (const name of names) {
    const value = direct.get(name.toLowerCase());
    if (value !== undefined) return value;
  }
  return "";
}

function canadaUrl(source: SourceData): URL {
  const raw = source.url.trim();
  if (
    !raw ||
    raw === `https://${CANADABUYS_HOST}` ||
    raw === `https://${CANADABUYS_HOST}/`
  ) {
    return new URL(CANADABUYS_OPEN_TENDERS);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceAccessError(
      "INVALID_SOURCE",
      "The CanadaBuys source URL is invalid."
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== CANADABUYS_HOST ||
    !url.pathname.startsWith("/opendata/pub/") ||
    !url.pathname.endsWith(".csv") ||
    url.username ||
    url.password ||
    hasAuthQuery(url)
  ) {
    throw new SourceAccessError(
      "INVALID_SOURCE",
      "The CanadaBuys source URL is not permitted."
    );
  }
  return url;
}

function canadaType(row: Record<string, string>): OpportunityData["type"] {
  const english = column(row, ["noticeType-avisType-eng"]);
  // These are CanadaBuys' native English labels. Make the public RFP label
  // explicit rather than relying on a generic text heuristic.
  if (/^request for proposal(?:s)?$/i.test(english) || /^rfp\b/i.test(english))
    return "RFP";
  return typeFromText(
    english || column(row, ["noticeType-avisType-fra", "notice type"])
  );
}

function canadaStatus(
  row: Record<string, string>
): OpportunityData["noticeStatus"] {
  return statusFromText(
    column(row, [
      "tenderStatus-appelOffresStatut-eng",
      "tenderStatus-appelOffresStatut-fra",
      "status",
    ])
  );
}

function mapCanadaRow(row: Record<string, string>): Partial<OpportunityData> {
  const solicitation = column(row, [
    "solicitationNumber-numeroSollicitation",
    "solicitationNumber",
    "solicitation number",
  ]);
  const reference = column(row, [
    "referenceNumber-numeroReference",
    "referenceNumber",
    "reference number",
  ]);
  const title = column(row, ["title-titre-eng", "title-titre-fra", "title"]);
  const description = column(row, [
    "tenderDescription-descriptionAppelOffres-eng",
    "tenderDescription-descriptionAppelOffres-fra",
    "description",
  ]);
  const attachments = extractAttachments(
    column(row, [
      "attachment-piecesJointes-eng",
      "attachment-piecesJointes-fra",
      "attachments",
    ]),
    "CanadaBuys attachment"
  );
  const notice = externalUrl(
    column(row, [
      "noticeURL-URLavis-eng",
      "noticeURL-URLavis-fra",
      "noticeURL",
      "url",
    ])
  );
  return {
    externalId: solicitation,
    title,
    buyer: column(row, [
      "contractingEntityName-nomEntiteContractante-eng",
      "contractingEntityName-nomEntiteContractante-fra",
      "contractingEntityName",
      "buyer",
    ]),
    country: "Canada",
    type: canadaType(row),
    noticeStatus: canadaStatus(row),
    solicitationId: reference || solicitation,
    url: notice,
    postedAt: column(row, [
      "publicationDate-datePublication",
      "publicationDate",
      "postedAt",
    ]),
    dueDate: column(row, [
      "tenderClosingDate-appelOffresDateCloture",
      "tenderClosingDate",
      "dueDate",
    ]),
    description,
    cpv: splitTags(column(row, ["unspsc", "gsin-nibs"])),
    geographies: splitTags(
      column(row, [
        "regionsOfDelivery-regionsLivraison-eng",
        "regionsOfDelivery-regionsLivraison-fra",
        "regionsOfOpportunity-regionAppelOffres-eng",
        "regionsOfOpportunity-regionAppelOffres-fra",
      ])
    ),
    eligibilityNotes:
      "Imported from the CanadaBuys CSV snapshot; mandatory eligibility was not reviewed.",
    attachments: appendAttachments(attachments),
  };
}

async function pullCanadaBuys(
  source: SourceData,
  cursor?: string | null
): Promise<PullResult> {
  const url = canadaUrl(source);
  const csv = await (
    await publicFetch(url, { allowedHosts: [CANADABUYS_HOST] })
  ).text();
  const rows = parseCsv(csv);
  const hash = contentHash(csv);
  const offset = snapshotOffset(cursor, "canadabuys", hash);
  const opportunities: OpportunityData[] = [];
  const warnings: string[] = [];
  const initialFrom = daysAgo(source.lookbackDays);
  let nextOffset = rows.length;
  for (let index = offset; index < rows.length; index += 1) {
    const row = rows[index];
    const posted = dateOnly(
      column(row, [
        "publicationDate-datePublication",
        "publicationDate",
        "postedAt",
      ])
    );
    if (posted && posted < initialFrom) continue;
    addCandidate(source, mapCanadaRow(row), opportunities, warnings);
    if (opportunities.length >= source.maxItems) {
      nextOffset = index + 1;
      break;
    }
  }
  return {
    opportunities,
    nextCursor: snapshotCursor(
      "canadabuys",
      nextOffset,
      hash,
      nextOffset < rows.length
    ),
    warnings,
  };
}

function configuredFeedUrl(source: SourceData): URL {
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    throw new SourceAccessError(
      "INVALID_SOURCE",
      "The custom feed URL is invalid."
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    hasAuthQuery(url)
  ) {
    throw new SourceAccessError(
      "INVALID_SOURCE",
      "Custom feeds require a public HTTPS URL without credentials."
    );
  }
  return url;
}

function jsonPageUrl(
  source: SourceData,
  cursor?: string | null
): { initial: URL; page: URL; saved: z.infer<typeof jsonCursorSchema> | null } {
  const initial = configuredFeedUrl(source);
  const saved = parseCursor(cursor, jsonCursorSchema);
  if (!saved) return { initial, page: initial, saved: null };
  let savedUrl: URL;
  try {
    savedUrl = new URL(saved.url);
  } catch {
    throw new SourceAccessError(
      "INVALID_CURSOR",
      "The saved source cursor is invalid."
    );
  }
  const checked = validSameOriginPage(
    saved.url,
    initial,
    savedUrl.pathname,
    initial.hostname
  );
  if (!checked)
    throw new SourceAccessError(
      "INVALID_CURSOR",
      "The saved source cursor is invalid."
    );
  return { initial, page: new URL(checked), saved };
}

async function pullJson(
  source: SourceData,
  cursor?: string | null
): Promise<PullResult> {
  const { initial, page, saved } = jsonPageUrl(source, cursor);
  const response = await publicFetch(page, {
    allowedHosts: [initial.hostname],
  });
  const payload = feedEnvelopeSchema.safeParse(await response.json());
  if (!payload.success)
    throw new SourceAccessError(
      "INVALID_RESPONSE",
      "The source returned an invalid opportunity feed."
    );
  const hash = Buffer.isBuffer(response.body)
    ? contentHash(response.body)
    : contentHash(JSON.stringify(payload.data));
  const start =
    saved?.contentHash === hash
      ? Math.min(saved.index, payload.data.opportunities.length)
      : 0;
  const opportunities: OpportunityData[] = [];
  const warnings: string[] = [];
  let nextIndex = payload.data.opportunities.length;
  for (
    let index = start;
    index < payload.data.opportunities.length;
    index += 1
  ) {
    const item = payload.data.opportunities[index];
    addCandidate(
      source,
      {
        ...item,
        eligibilityReviewed: false,
        eligibilityNotes:
          "Imported from a configured JSON feed; mandatory eligibility was not independently reviewed.",
      },
      opportunities,
      warnings
    );
    if (opportunities.length >= source.maxItems) {
      nextIndex = index + 1;
      break;
    }
  }
  let nextCursor: string | null = null;
  if (nextIndex < payload.data.opportunities.length) {
    nextCursor = makeCursor({
      version: 1,
      kind: "json",
      url: page.toString(),
      index: nextIndex,
      contentHash: hash,
    });
  } else if (payload.data.nextUrl) {
    const next = validSameOriginPage(
      payload.data.nextUrl,
      page,
      new URL(payload.data.nextUrl, page).pathname,
      initial.hostname
    );
    if (next)
      nextCursor = makeCursor({
        version: 1,
        kind: "json",
        url: next,
        index: 0,
      });
    else
      warnings.push(
        "An off-origin or credentialed JSON next page was ignored."
      );
  }
  return { opportunities, nextCursor, warnings };
}

function xmlText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number")
    return text(value);
  const item = record(value);
  return text(item["#text"] || item["__cdata"], 1_000_000);
}

function xmlLink(value: unknown, base: URL): string {
  for (const entry of Array.isArray(value) ? value : [value]) {
    const item = record(entry);
    const rel = text(item["@_rel"], 40).toLowerCase();
    const candidate = text(item["@_href"] || entry, 2_000);
    if (!rel || rel === "alternate") {
      const url = externalUrl(candidate, base);
      if (url) return url;
    }
  }
  return "";
}

function rssId(value: unknown, fallback: string): string {
  const stable = xmlText(value) || fallback;
  return (
    text(stable, 300) || createHash("sha256").update(fallback).digest("hex")
  );
}

function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function pullRss(
  source: SourceData,
  cursor?: string | null
): Promise<PullResult> {
  const url = configuredFeedUrl(source);
  const xml = await (
    await publicFetch(url, { allowedHosts: [url.hostname] })
  ).text();
  let parsed: UnknownRecord;
  try {
    parsed = record(
      new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        textNodeName: "#text",
        cdataPropName: "__cdata",
        parseTagValue: false,
      }).parse(xml)
    );
  } catch {
    throw new SourceAccessError(
      "INVALID_RESPONSE",
      "The source returned invalid RSS or Atom XML."
    );
  }
  const rssItems = records(record(record(parsed.rss).channel).item);
  const atomEntries = records(record(parsed.feed).entry);
  const items = rssItems.length ? rssItems : atomEntries;
  if (!items.length && !Object.keys(parsed).length) {
    throw new SourceAccessError(
      "INVALID_RESPONSE",
      "The source returned invalid RSS or Atom XML."
    );
  }
  const hash = contentHash(xml);
  const offset = snapshotOffset(cursor, "rss", hash);
  const opportunities: OpportunityData[] = [];
  const warnings: string[] = [];
  let nextOffset = items.length;
  for (let index = offset; index < items.length; index += 1) {
    const item = items[index];
    const title = xmlText(item.title);
    const link = xmlLink(item.link, url);
    const identifier = rssId(
      item.guid || item.id,
      `${link}|${title}|${xmlText(item.pubDate || item.published || item.updated)}`
    );
    addCandidate(
      source,
      {
        externalId: identifier,
        title,
        buyer: "",
        country: source.country,
        type: "Other",
        noticeStatus: "Open",
        solicitationId: "",
        url: link,
        postedAt: xmlText(item.pubDate || item.published || item.updated).slice(
          0,
          80
        ),
        dueDate: "",
        description: stripMarkup(
          xmlText(item.description || item.summary || item.content)
        ).slice(0, 1_000_000),
        eligibilityNotes:
          "Imported from an RSS/Atom notice summary; requirements and eligibility were not analyzed.",
        documents: [],
        attachments: link ? [{ name: "Notice summary link", url: link }] : [],
      },
      opportunities,
      warnings
    );
    if (opportunities.length >= source.maxItems) {
      nextOffset = index + 1;
      break;
    }
  }
  return {
    opportunities,
    nextCursor: snapshotCursor(
      "rss",
      nextOffset,
      hash,
      nextOffset < items.length
    ),
    warnings,
  };
}

function csvType(row: Record<string, string>): OpportunityData["type"] {
  const raw = column(row, ["type", "noticeType", "notice_type"]);
  return (["RFP", "RFI", "Sources sought", "Other"] as const).includes(
    raw as OpportunityData["type"]
  )
    ? (raw as OpportunityData["type"])
    : typeFromText(raw);
}

function csvStatus(
  row: Record<string, string>
): OpportunityData["noticeStatus"] {
  const raw = column(row, ["noticeStatus", "notice_status", "status"]);
  return (["Open", "Closed", "Cancelled", "Award"] as const).includes(
    raw as OpportunityData["noticeStatus"]
  )
    ? (raw as OpportunityData["noticeStatus"])
    : statusFromText(raw);
}

function mapCsvRow(
  row: Record<string, string>,
  source: SourceData
): Partial<OpportunityData> {
  const attachments = extractAttachments(
    column(row, ["attachments", "attachmentUrls", "attachment_urls"]),
    "CSV attachment"
  );
  return {
    externalId: column(row, [
      "externalId",
      "external_id",
      "id",
      "solicitationId",
      "solicitation_id",
    ]),
    title: column(row, ["title", "noticeTitle", "notice_title"]),
    buyer: column(row, ["buyer", "buyerName", "buyer_name"]),
    country: column(row, ["country"]) || source.country,
    type: csvType(row),
    noticeStatus: csvStatus(row),
    solicitationId: column(row, [
      "solicitationId",
      "solicitation_id",
      "reference",
      "referenceNumber",
    ]),
    url: externalUrl(column(row, ["url", "link", "noticeUrl", "notice_url"])),
    postedAt: column(row, [
      "postedAt",
      "posted_at",
      "publicationDate",
      "publication_date",
    ]),
    dueDate: column(row, [
      "dueDate",
      "due_date",
      "closingDate",
      "closing_date",
    ]),
    description: column(row, ["description", "summary"]),
    naics: splitTags(column(row, ["naics"])),
    cpv: splitTags(
      column(row, ["cpv", "classification", "classificationCode"])
    ),
    geographies: splitTags(
      column(row, ["geographies", "geography", "regions"])
    ),
    capabilities: splitTags(column(row, ["capabilities"])),
    value: column(row, ["value", "estimatedValue", "estimated_value"]),
    currency: currency(column(row, ["currency"])),
    eligibilityNotes:
      "Imported from a CSV feed; mandatory eligibility was not independently reviewed.",
    attachments,
  };
}

async function pullCsv(
  source: SourceData,
  cursor?: string | null
): Promise<PullResult> {
  const url = configuredFeedUrl(source);
  const csv = await (
    await publicFetch(url, { allowedHosts: [url.hostname] })
  ).text();
  const rows = parseCsv(csv);
  const hash = contentHash(csv);
  const offset = snapshotOffset(cursor, "csv", hash);
  const opportunities: OpportunityData[] = [];
  const warnings: string[] = [];
  let nextOffset = rows.length;
  for (let index = offset; index < rows.length; index += 1) {
    const row = rows[index];
    addCandidate(source, mapCsvRow(row, source), opportunities, warnings);
    if (opportunities.length >= source.maxItems) {
      nextOffset = index + 1;
      break;
    }
  }
  return {
    opportunities,
    nextCursor: snapshotCursor(
      "csv",
      nextOffset,
      hash,
      nextOffset < rows.length
    ),
    warnings,
  };
}

/**
 * Pull a bounded page of a configured source. Cursors are versioned JSON created
 * by this module, then revalidated before use so an upstream next-link cannot
 * turn a later run into an arbitrary request.
 */
export async function pullSource(
  sourceInput: SourceData,
  cursor?: string | null
): Promise<PullResult> {
  const source = sourceData(sourceInput);
  try {
    switch (source.kind as string) {
      case "manual":
        return { opportunities: [], nextCursor: null, warnings: [] };
      case "sam":
        return await pullSam(source, cursor);
      case "ted":
        return await pullTed(source, cursor);
      case "findtender":
        return await pullFindTender(source, cursor);
      case "contracts-finder":
        return await pullContractsFinder(source, cursor);
      case "canadabuys":
        return await pullCanadaBuys(source, cursor);
      case "json":
        return await pullJson(source, cursor);
      case "rss":
        return await pullRss(source, cursor);
      case "csv":
        return await pullCsv(source, cursor);
      default:
        throw new SourceAccessError(
          "INVALID_SOURCE",
          "The source configuration is invalid."
        );
    }
  } catch (error) {
    if (error instanceof SourceAccessError) throw error;
    // Do not surface provider response bodies, request URLs or API-key-bearing URLs to callers.
    throw new SourceAccessError(
      "SOURCE_READ_FAILED",
      "The source could not be read."
    );
  }
}
