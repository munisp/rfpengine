import {
  defaultPolicy,
  type CompanyProfile,
  type OpportunityData,
  type OpportunityRecord,
  type ProfileRecord,
  type SourceData,
} from "@shared/capture";
import type { CatalogItem } from "./Capture";

export type SourceRecord = {
  id: string;
  version: number;
  data: SourceData;
  lastSyncAt: string | null;
  lastError: string | null;
  nextCursor: string | null;
};

export type PipelinePolicy = typeof defaultPolicy;
export type PipelineSettings = {
  policy: PipelinePolicy;
  active: boolean;
  taskUid: string | null;
  lastRunAt: string | null;
};

export type CaptureJob = {
  id: string;
  kind: "sync" | "response";
  status: "Queued" | "Running" | "Succeeded" | "Failed";
  attempts: number;
  error: string | null;
  result: { workspaceId?: string } | null;
  createdAt: string;
};

export type CaptureRun = {
  id: string;
  status: "Running" | "Succeeded" | "Partial" | "Failed";
  processed: number;
  succeeded: number;
  failed: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type SampleCaptureState = {
  profiles: ProfileRecord[];
  sources: SourceRecord[];
  opportunities: OpportunityRecord[];
  settings: PipelineSettings;
  jobs: CaptureJob[];
  runs: CaptureRun[];
};

const isoDaysFromNow = (days: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const cloudProfile = (): CompanyProfile => ({
  name: "Aster Cloud Systems",
  description:
    "Cloud modernization and secure platform delivery for public-sector teams.",
  capabilities: [
    "cloud migration",
    "zero trust",
    "DevSecOps",
    "platform engineering",
  ],
  naics: ["541512", "541519"],
  cpv: ["72000000"],
  geographies: ["United States", "Worldwide"],
  preferredBuyers: ["Civic Digital Services"],
  statuses: [
    { name: "Small business", validUntil: isoDaysFromNow(365), attested: true },
  ],
  certifications: [
    { name: "ISO 27001", validUntil: isoDaysFromNow(365), approved: true },
  ],
  minValue: "50000",
  maxValue: "2500000",
  currency: "USD",
  capacityVerified: true,
  capacity: "Two delivery pods available for projects beginning this quarter.",
  pastPerformance: [
    {
      name: "Citizen services platform modernization",
      buyer: "Civic Digital Services",
      completed: isoDaysFromNow(-120),
      scope:
        "Migrated public-facing services to a secure, observable cloud platform.",
    },
  ],
  voice:
    "Use direct, specific, evidence-grounded language. Avoid unverified claims.",
  evidence: [
    {
      id: "evidence-cloud-1",
      name: "Cloud delivery capability statement.txt",
      category: "Capability statement",
      uploadedAt: isoDaysFromNow(-5),
      approved: true,
      text: "Aster Cloud Systems delivers cloud migration, zero trust, DevSecOps and platform engineering for public-sector teams.",
    },
  ],
  autoDraft: false,
  active: true,
});

const constructionProfile = (): CompanyProfile => ({
  name: "Northline Construction Group",
  description: "Civil construction and facilities delivery contractor.",
  capabilities: [
    "civil construction",
    "site preparation",
    "facilities delivery",
  ],
  naics: ["236220", "237310"],
  cpv: ["45000000"],
  geographies: ["United States"],
  preferredBuyers: ["Regional Works Authority"],
  statuses: [],
  certifications: [],
  minValue: "250000",
  maxValue: "10000000",
  currency: "USD",
  capacityVerified: true,
  capacity: "Available after current regional facilities programme closes.",
  pastPerformance: [],
  voice: "Use restrained, evidence-based proposal language.",
  evidence: [],
  autoDraft: false,
  active: true,
});

const cloudOpportunity = (): OpportunityData => ({
  externalId: "CDS-2026-CLOUD-041",
  title: "Secure Cloud Platform Modernization Services",
  buyer: "Civic Digital Services",
  country: "United States",
  type: "RFP",
  noticeStatus: "Open",
  solicitationId: "CDS-041",
  url: "https://example.gov/notices/CDS-041",
  postedAt: isoDaysFromNow(-3),
  dueDate: isoDaysFromNow(24),
  description:
    "Civic Digital Services seeks cloud migration, zero trust, DevSecOps and platform engineering services for citizen-facing systems.",
  naics: ["541512"],
  cpv: ["72000000"],
  geographies: ["United States"],
  capabilities: ["cloud migration", "zero trust", "DevSecOps"],
  value: "850000",
  currency: "USD",
  requiredStatuses: ["Small business"],
  requiredCertifications: ["ISO 27001"],
  eligibilityReviewed: true,
  eligibilityNotes: "Requirements reviewed locally against the notice summary.",
  documents: [
    {
      id: "doc-cloud-1",
      name: "Solicitation summary.txt",
      category: "Solicitation",
      uploadedAt: isoDaysFromNow(-3),
      approved: true,
      text: "Cloud migration, zero trust and DevSecOps requirements. Small business and ISO 27001 required.",
    },
  ],
  attachments: [],
});

const incompleteOpportunity = (): OpportunityData => ({
  externalId: "RWA-2026-118",
  title: "Regional Facilities and Site Works Support",
  buyer: "Regional Works Authority",
  country: "United States",
  type: "RFI",
  noticeStatus: "Open",
  solicitationId: "RWA-118",
  url: "https://example.gov/notices/RWA-118",
  postedAt: isoDaysFromNow(-1),
  dueDate: isoDaysFromNow(18),
  description:
    "Market research for regional site works and facilities support.",
  naics: ["237310"],
  cpv: ["45000000"],
  geographies: ["United States"],
  capabilities: ["civil construction", "site preparation"],
  value: null,
  currency: "Unknown",
  requiredStatuses: [],
  requiredCertifications: [],
  eligibilityReviewed: false,
  eligibilityNotes: "",
  documents: [],
  attachments: [
    {
      name: "RFI attachments",
      url: "https://example.gov/notices/RWA-118/files",
    },
  ],
});

export const sourceCatalogLocal: CatalogItem[] = [
  {
    kind: "sam",
    name: "SAM.gov",
    access: "Server API key required",
    url: "https://sam.gov",
    note: "Official opportunities API; key availability is checked on the server.",
    configured: false,
  },
  {
    kind: "ted",
    name: "TED · European Union",
    access: "Official public API",
    url: "https://ted.europa.eu",
    note: "Public EU procurement notices.",
    configured: true,
  },
  {
    kind: "findtender",
    name: "Find a Tender · UK",
    access: "Official public OCDS API",
    url: "https://www.find-tender.service.gov.uk",
    note: "UK notice data through the official OCDS API.",
    configured: true,
  },
  {
    kind: "contracts-finder",
    name: "Contracts Finder · UK",
    access: "Official public OCDS API",
    url: "https://www.contractsfinder.service.gov.uk",
    note: "Published UK opportunity notices.",
    configured: true,
  },
  {
    kind: "canadabuys",
    name: "CanadaBuys",
    access: "Official public CSV snapshots",
    url: "https://canadabuys.canada.ca",
    note: "Federal tender snapshot feed.",
    configured: true,
  },
  {
    kind: "json",
    name: "Authorized JSON feed",
    access: "Configured public feed",
    url: "",
    note: "Use an authorized public HTTPS feed without credentials in its URL.",
    configured: true,
  },
];

export function createSampleCaptureState(): SampleCaptureState {
  return {
    profiles: [
      {
        id: "local-profile-cloud",
        version: 3,
        data: cloudProfile(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "local-profile-construction",
        version: 2,
        data: constructionProfile(),
        updatedAt: new Date().toISOString(),
      },
    ],
    sources: [
      {
        id: "local-source-manual",
        version: 1,
        data: {
          name: "Local notice intake",
          kind: "manual",
          url: "",
          keywords: "cloud, modernization, infrastructure",
          country: "United States",
          enabled: true,
          lookbackDays: 14,
          maxItems: 50,
        },
        lastSyncAt: null,
        lastError: null,
        nextCursor: null,
      },
    ],
    opportunities: [
      {
        id: "local-opportunity-cloud",
        sourceId: "local-source-manual",
        sourceName: "Local notice intake",
        version: 4,
        data: cloudOpportunity(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "local-opportunity-facilities",
        sourceId: "local-source-manual",
        sourceName: "Local notice intake",
        version: 1,
        data: incompleteOpportunity(),
        updatedAt: new Date().toISOString(),
      },
    ],
    settings: {
      policy: { ...defaultPolicy },
      active: false,
      taskUid: null,
      lastRunAt: null,
    },
    jobs: [],
    runs: [],
  };
}
