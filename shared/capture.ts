import { z } from "zod";
import { documentSchema } from "./bid";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(v => {
    const d = new Date(v + "T00:00:00Z");
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Use a valid YYYY-MM-DD date");
const short = z.string().trim().max(200);
const tags = z.array(z.string().trim().min(1).max(160)).max(100);
const money = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/);
export const normalizeTag = (v: string) =>
  v
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Exact aliases used by official sources; this deliberately does not perform fuzzy matching. */
const statusAliases: Record<string, string> = {
  sba: "small business",
  sb: "small business",
  "small business concern": "small business",
  sdb: "small disadvantaged business",
  wosb: "woman owned small business",
  edwosb: "economically disadvantaged woman owned small business",
  vosb: "veteran owned small business",
  sdvosb: "service disabled veteran owned small business",
  hubzone: "hubzone",
};
const countryAliases: Record<string, string> = {
  us: "united states",
  "u s": "united states",
  usa: "united states",
  "united states of america": "united states",
  uk: "united kingdom",
  "u k": "united kingdom",
  "great britain": "united kingdom",
};
const canonicalStatus = (value: string) =>
  statusAliases[normalizeTag(value)] ?? normalizeTag(value);
const canonicalGeography = (value: string) =>
  countryAliases[normalizeTag(value)] ?? normalizeTag(value);
const canonicalClassification = (value: string) => {
  const normalized = normalizeTag(value);
  const naics = /^naics (\d{2,6})$/.exec(normalized);
  const cpv = /^cpv (\d{8})$/.exec(normalized);
  return naics?.[1] ?? cpv?.[1] ?? normalized;
};
const addDuplicateNameIssues = (
  ctx: z.RefinementCtx,
  values: { name: string }[],
  normalizer: (value: string) => string,
  path: string[],
  label: string
) => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const key = normalizer(value.name);
    if (seen.has(key))
      ctx.addIssue({
        code: "custom",
        path: [...path, index, "name"],
        message: `Duplicate ${label} names are not allowed.`,
      });
    else seen.add(key);
  });
};
const publicHttpsUrl = z
  .string()
  .trim()
  .max(2000)
  .superRefine((value, ctx) => {
    if (!value) return;
    try {
      const parsed = new URL(value);
      if (
        parsed.protocol !== "https:" ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password
      )
        throw Error();
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "Use an empty value or a public HTTPS URL without credentials.",
      });
    }
  });
const captureDocumentSchema = documentSchema.extend({
  id: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(255),
  category: z.string().trim().max(120),
  text: z.string().max(1000000),
  approved: z.boolean(),
  uploadedAt: z.string().trim().min(1).max(80),
});
export const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(15000),
    capabilities: tags,
    naics: tags,
    cpv: tags,
    geographies: tags,
    preferredBuyers: tags,
    statuses: z
      .array(
        z.object({
          name: short.min(1),
          validUntil: date,
          attested: z.boolean(),
        })
      )
      .max(40),
    certifications: z
      .array(
        z.object({
          name: short.min(1),
          validUntil: date,
          approved: z.boolean(),
        })
      )
      .max(50),
    minValue: money,
    maxValue: money,
    currency: z.enum(["USD", "EUR", "GBP", "CAD", "AUD"]),
    capacity: z.string().max(5000),
    capacityVerified: z.boolean().default(false),
    pastPerformance: z
      .array(
        z.object({
          name: short.min(1),
          buyer: short,
          completed: date,
          scope: z.string().max(5000),
        })
      )
      .max(100),
    voice: z.string().max(3000),
    evidence: z
      .array(captureDocumentSchema.extend({ text: z.string().max(500000) }))
      .max(40),
    autoDraft: z.boolean(),
    active: z.boolean(),
  })
  .superRefine((value, ctx) => {
    addDuplicateNameIssues(
      ctx,
      value.statuses,
      canonicalStatus,
      ["statuses"],
      "business status"
    );
    addDuplicateNameIssues(
      ctx,
      value.certifications,
      normalizeTag,
      ["certifications"],
      "certification"
    );
    const evidenceIds = new Set<string>(),
      evidenceNames = new Set<string>();
    value.evidence.forEach((document, index) => {
      const id = document.id.trim(),
        name = normalizeTag(document.name);
      if (evidenceIds.has(id))
        ctx.addIssue({
          code: "custom",
          path: ["evidence", index, "id"],
          message: "Evidence document IDs must be unique.",
        });
      else evidenceIds.add(id);
      if (evidenceNames.has(name))
        ctx.addIssue({
          code: "custom",
          path: ["evidence", index, "name"],
          message: "Evidence document names must be unique.",
        });
      else evidenceNames.add(name);
    });
  })
  .refine(
    v => Number(v.maxValue) === 0 || Number(v.minValue) <= Number(v.maxValue),
    "Maximum value must be zero (unbounded) or at least minimum"
  );
export type CompanyProfile = z.infer<typeof profileSchema>;
export type ProfileRecord = {
  id: string;
  version: number;
  data: CompanyProfile;
  updatedAt: string;
};
export const emptyProfile = (name = ""): CompanyProfile => ({
  name,
  description: "",
  capabilities: [],
  naics: [],
  cpv: [],
  geographies: [],
  preferredBuyers: [],
  statuses: [],
  certifications: [],
  minValue: "0",
  maxValue: "0",
  currency: "USD",
  capacity: "",
  capacityVerified: false,
  pastPerformance: [],
  voice: "Use direct, specific, evidence-grounded language.",
  evidence: [],
  autoDraft: false,
  active: true,
});
export const sourceKindSchema = z.enum([
  "sam",
  "ted",
  "findtender",
  "contracts-finder",
  "canadabuys",
  "json",
  "rss",
  "csv",
  "manual",
]);
export const sourceSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    kind: sourceKindSchema,
    url: z.string().trim().max(2000),
    keywords: z.string().trim().max(300),
    country: short,
    enabled: z.boolean(),
    lookbackDays: z.number().int().min(1).max(30),
    maxItems: z.number().int().min(1).max(100),
  })
  .superRefine((v, c) => {
    if (["json", "rss", "csv"].includes(v.kind)) {
      try {
        const u = new URL(v.url);
        if (
          u.protocol !== "https:" ||
          u.username ||
          u.password ||
          u.searchParams.has("api_key") ||
          u.searchParams.has("token") ||
          u.searchParams.has("key")
        )
          throw Error();
      } catch {
        c.addIssue({
          code: "custom",
          message:
            "Custom feeds require a public HTTPS URL without credentials or tokens.",
          path: ["url"],
        });
      }
    }
  });
export type SourceData = z.infer<typeof sourceSchema>;
const attachmentSchema = z.object({
  name: z.string().trim().min(1).max(300),
  url: publicHttpsUrl,
});
export const opportunitySchema = z
  .object({
    externalId: z.string().trim().min(1).max(300),
    title: z.string().trim().min(1).max(500),
    buyer: short,
    country: short,
    type: z.enum(["RFP", "RFI", "Sources sought", "Other"]),
    noticeStatus: z.enum(["Open", "Closed", "Cancelled", "Award"]),
    solicitationId: short,
    url: publicHttpsUrl,
    postedAt: z.string().max(80),
    dueDate: z.union([date, z.literal("")]),
    description: z.string().max(1000000),
    naics: tags,
    cpv: tags,
    geographies: tags,
    capabilities: tags,
    value: money.nullable(),
    currency: z.enum(["USD", "EUR", "GBP", "CAD", "AUD", "Unknown"]),
    requiredStatuses: tags,
    requiredCertifications: tags,
    eligibilityReviewed: z.boolean(),
    eligibilityNotes: z.string().max(10000),
    documents: z.array(captureDocumentSchema).max(40),
    attachments: z.array(attachmentSchema).max(100),
  })
  .superRefine((value, ctx) =>
    addDuplicateNameIssues(
      ctx,
      value.attachments,
      normalizeTag,
      ["attachments"],
      "attachment"
    )
  );
export type OpportunityData = z.infer<typeof opportunitySchema>;
export type OpportunityRecord = {
  id: string;
  sourceId: string;
  version: number;
  data: OpportunityData;
  updatedAt: string;
  sourceName?: string;
};
export const emptyOpportunity = (title = ""): OpportunityData => ({
  externalId: "",
  title,
  buyer: "",
  country: "",
  type: "RFP",
  noticeStatus: "Open",
  solicitationId: "",
  url: "",
  postedAt: "",
  dueDate: "",
  description: "",
  naics: [],
  cpv: [],
  geographies: [],
  capabilities: [],
  value: null,
  currency: "Unknown",
  requiredStatuses: [],
  requiredCertifications: [],
  eligibilityReviewed: false,
  eligibilityNotes: "",
  documents: [],
  attachments: [],
});
export type EligibilityState = "PASS" | "FAIL" | "UNKNOWN";
export type MatchResult = {
  score: number;
  eligibility: EligibilityState;
  autoDraftAllowed: boolean;
  coverage: number;
  reasons: string[];
  blockers: string[];
  unknowns: string[];
  components: {
    capabilities: number;
    classification: number;
    geography: number;
    buyer: number;
    evidence: number;
  };
  version: "capture-match-v1";
};
const overlaps = (
  a: string[],
  b: string[],
  normalizer: (value: string) => string = normalizeTag
) => {
  const candidates = new Set(b.map(normalizer)),
    seen = new Set<string>();
  return a.filter(value => {
    const normalized = normalizer(value);
    if (!normalized || seen.has(normalized) || !candidates.has(normalized))
      return false;
    seen.add(normalized);
    return true;
  });
};
export function matchOpportunity(
  profile: CompanyProfile,
  opportunity: OpportunityData,
  asOf = new Date().toISOString().slice(0, 10)
): MatchResult {
  const p = profileSchema.parse(profile),
    o = opportunitySchema.parse(opportunity);
  date.parse(asOf);
  const blockers: string[] = [],
    unknowns: string[] = [],
    reasons: string[] = [];
  if (!p.active) blockers.push("Company profile is archived.");
  if (o.noticeStatus !== "Open")
    blockers.push(`Notice is ${o.noticeStatus.toLowerCase()}.`);
  if (o.type === "Other")
    blockers.push("Notice is not a classified RFP, RFI or Sources sought.");
  if (!o.dueDate) unknowns.push("Response deadline is not verified.");
  else if (o.dueDate < asOf) blockers.push("Response deadline has passed.");
  if (!o.eligibilityReviewed)
    unknowns.push("Mandatory eligibility requirements have not been reviewed.");
  const hasScopeText =
    Boolean(o.description.trim()) ||
    o.documents.some(document => Boolean(document.text.trim()));
  if (!hasScopeText) unknowns.push("Solicitation scope text is absent.");
  if (o.attachments.length) {
    const importedNames = new Set(
      o.documents.map(document => normalizeTag(document.name))
    );
    const missingAttachments = o.attachments.filter(
      attachment => !importedNames.has(normalizeTag(attachment.name))
    );
    if (missingAttachments.length)
      unknowns.push(
        `Full solicitation document set is incomplete: ${missingAttachments.length} listed attachment${missingAttachments.length === 1 ? " is" : "s are"} not imported by name.`
      );
  }
  const certificationRequiredThrough =
    o.dueDate && o.dueDate > asOf ? o.dueDate : asOf;
  for (const required of o.requiredStatuses) {
    const facts = p.statuses.filter(
      x => canonicalStatus(x.name) === canonicalStatus(required)
    );
    if (!facts.length)
      unknowns.push(`Required business status not documented: ${required}.`);
    else if (!facts.some(x => x.attested && x.validUntil >= asOf))
      blockers.push(
        `Required business status is expired or lacks a current attestation: ${required}.`
      );
    else reasons.push(`Current business-status attestation: ${required}.`);
  }
  for (const required of o.requiredCertifications) {
    const facts = p.certifications.filter(
      x => normalizeTag(x.name) === normalizeTag(required)
    );
    if (!facts.length)
      unknowns.push(`Required certification not documented: ${required}.`);
    else if (
      !facts.some(
        x => x.approved && x.validUntil >= certificationRequiredThrough
      )
    )
      blockers.push(
        `Required certification is expired, unapproved, or does not remain valid through the response deadline: ${required}.`
      );
    else
      reasons.push(
        `Approved certification record valid through ${certificationRequiredThrough}: ${required}.`
      );
  }
  if (o.value !== null) {
    if (o.currency === "Unknown")
      unknowns.push("Opportunity value currency is unknown.");
    else if (o.currency !== p.currency)
      unknowns.push(
        "Opportunity and company value bounds use different currencies; no FX assumed."
      );
    else {
      if (Number(o.value) < Number(p.minValue))
        blockers.push("Opportunity is below company minimum contract value.");
      if (Number(p.maxValue) > 0 && Number(o.value) > Number(p.maxValue))
        blockers.push("Opportunity exceeds company maximum contract value.");
    }
  } else
    unknowns.push(
      "Contract value is not published; value capacity cannot be verified."
    );
  const locationTerms = o.geographies.length
    ? o.geographies
    : o.country
      ? [o.country]
      : [];
  const geographyMatches = overlaps(
    locationTerms,
    p.geographies,
    canonicalGeography
  );
  const worldwide = p.geographies.some(x =>
    ["worldwide", "global", "any"].includes(normalizeTag(x))
  );
  const requiredCapabilities = o.capabilities;
  const hitCapabilities = overlaps(requiredCapabilities, p.capabilities);
  const noticeText = " " + normalizeTag(o.title + " " + o.description) + " ";
  const lexicalHits = p.capabilities.filter(v => {
    const term = normalizeTag(v);
    return term.length >= 4 && noticeText.includes(" " + term + " ");
  });
  const capCoverage = requiredCapabilities.length
    ? hitCapabilities.length / requiredCapabilities.length
    : Math.min(
        lexicalHits.length / Math.max(1, Math.min(p.capabilities.length, 5)),
        1
      );
  if (
    requiredCapabilities.length &&
    hitCapabilities.length < requiredCapabilities.length
  )
    unknowns.push(
      "Some required capability labels are not declared by this company; review capability evidence."
    );
  const classifications =
    overlaps(o.naics, p.naics, canonicalClassification).length +
    overlaps(o.cpv, p.cpv, canonicalClassification).length;
  const buyerMatch = p.preferredBuyers.some(
    x => normalizeTag(x) === normalizeTag(o.buyer)
  );
  const evidence = p.evidence.filter(
    x =>
      x.approved &&
      x.category.trim().toLowerCase() !== "solicitation" &&
      x.text.trim().length > 0
  );
  const components = {
    capabilities: Math.round(40 * capCoverage),
    classification: classifications ? 20 : 0,
    geography: worldwide || geographyMatches.length ? 15 : 0,
    buyer: buyerMatch ? 10 : 0,
    evidence: evidence.length ? 15 : 0,
  };
  reasons.push(
    requiredCapabilities.length
      ? hitCapabilities.length
        ? `Declared capability labels overlap (fit signal only; not proof of qualification): ${hitCapabilities.join(", ")}.`
        : "No declared capability labels overlap the structured notice requirements."
      : `Notice keyword fit only (not verified requirements or eligibility): ${lexicalHits.length ? lexicalHits.join(", ") : "no declared capability terms found"}.`
  );
  reasons.push(
    classifications
      ? "Declared classification codes overlap."
      : "No NAICS/CPV overlap is documented."
  );
  if (!locationTerms.length)
    unknowns.push("Performance location is unspecified.");
  else if (!worldwide && !geographyMatches.length)
    unknowns.push(
      "Declared delivery geographies do not match the stated location; review local delivery feasibility."
    );
  if (!p.capacity.trim() || !p.capacityVerified)
    unknowns.push(
      "Delivery capacity needs a current company-owner availability attestation."
    );
  else
    reasons.push(
      "Company owner attested the recorded delivery capacity; opportunity-specific feasibility still requires review."
    );
  if (!evidence.length)
    unknowns.push("No approved company evidence is available for drafting.");
  else
    reasons.push(
      "Approved company evidence is available for drafting (15 readiness points); its text is not treated as proof of eligibility."
    );
  const eligibility = blockers.length
    ? "FAIL"
    : unknowns.length
      ? "UNKNOWN"
      : "PASS";
  return {
    score: Object.values(components).reduce((a, b) => a + b, 0),
    eligibility,
    autoDraftAllowed:
      eligibility === "PASS" && p.autoDraft && evidence.length > 0,
    coverage: Math.round(capCoverage * 100),
    reasons,
    blockers,
    unknowns,
    components,
    version: "capture-match-v1",
  };
}
export const policySchema = z.object({
  matchThreshold: z.number().int().min(0).max(100),
  autoRespond: z.boolean(),
  maxResponsesPerRun: z.number().int().min(1).max(3),
  maxSectionsPerResponse: z.number().int().min(1).max(8),
  maxJobsPerRun: z.number().int().min(1).max(10),
  cadenceMinutes: z.enum(["15", "30", "60"]),
});
export const defaultPolicy: z.infer<typeof policySchema> = {
  matchThreshold: 65,
  autoRespond: false,
  maxResponsesPerRun: 1,
  maxSectionsPerResponse: 4,
  maxJobsPerRun: 5,
  cadenceMinutes: "15",
};
export const feedEnvelopeSchema = z.object({
  opportunities: z.array(opportunitySchema).max(1000),
  nextUrl: z.string().max(2000).optional(),
});
export const sourceCatalog = [
  {
    kind: "sam",
    name: "SAM.gov",
    access: "Server API key required",
    url: "https://sam.gov",
    note: "Federal notices through the official Opportunities API. Restricted attachments may require separate authorized access.",
  },
  {
    kind: "ted",
    name: "TED · European Union",
    access: "Official public API",
    url: "https://ted.europa.eu",
    note: "EU public procurement notices; not every commercial/private tender.",
  },
  {
    kind: "findtender",
    name: "Find a Tender · UK",
    access: "Official public OCDS API",
    url: "https://www.find-tender.service.gov.uk",
    note: "UK notice data; linked tender documents may be held in buyer portals.",
  },
  {
    kind: "contracts-finder",
    name: "Contracts Finder · UK",
    access: "Official public OCDS API",
    url: "https://www.contractsfinder.service.gov.uk",
    note: "Published UK opportunity notices; API coverage and notice types depend on source.",
  },
  {
    kind: "json",
    name: "Authorized portal export / JSON",
    access: "Configured public feed",
    url: "",
    note: "Bring an authorized JSON opportunity feed; source license and record mapping must permit reuse.",
  },
  {
    kind: "rss",
    name: "RSS / Atom feed",
    access: "Configured public feed",
    url: "",
    note: "Notice summaries and links; import full documents before eligibility review and drafting.",
  },
  {
    kind: "csv",
    name: "CSV opportunity feed",
    access: "Configured public feed",
    url: "",
    note: "Mapped canonical CSV columns; no assumption of complete eligibility metadata.",
  },
  {
    kind: "canadabuys",
    name: "CanadaBuys",
    access: "Official public CSV snapshots",
    url: "https://canadabuys.canada.ca",
    note: "Federal tender snapshot feed; upstream refresh cadence and attachment copyright limits apply.",
  },
  {
    kind: null,
    name: "BidNet Direct",
    access: "Authorized account / licensed export",
    url: "https://www.bidnetdirect.com",
    note: "Not connected. Use a permitted export/feed; no login or scraping bypass.",
  },
  {
    kind: null,
    name: "GovWin IQ",
    access: "Licensed account / integration",
    url: "https://iq.govwin.com",
    note: "Not connected. Requires licensed data access and an authorized feed or API integration.",
  },
  {
    kind: null,
    name: "OpenGov / Bonfire / buyer portals",
    access: "Portal-specific authorized feed",
    url: "https://opengov.com/products/procurement/",
    note: "Not connected. Public buyer portals differ; authorized export/feed required.",
  },
] as const;
