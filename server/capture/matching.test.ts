import { describe, expect, it } from "vitest";
import {
  emptyOpportunity,
  emptyProfile,
  matchOpportunity,
  opportunitySchema,
  profileSchema,
  sourceCatalog,
  sourceKindSchema,
  type CompanyProfile,
  type OpportunityData,
} from "../../shared/capture";

const AS_OF = "2026-05-01";
const DUE = "2026-06-15";

const solicitationDocument = (
  name = "Notice.html",
  text = "The explicit solicitation scope is cloud modernization."
) => ({
  id: `doc-${name}`,
  name,
  category: "Solicitation",
  text,
  approved: false,
  uploadedAt: "2026-04-29T12:00:00Z",
});

function company(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    ...emptyProfile("Atlas Cloud Ltd"),
    description: "Public-sector cloud delivery.",
    capabilities: ["cloud migration", "zero trust"],
    naics: ["NAICS 541512"],
    cpv: ["CPV 72000000"],
    geographies: ["US"],
    preferredBuyers: ["Civic Digital Services"],
    statuses: [{ name: "SBA", validUntil: "2026-12-31", attested: true }],
    certifications: [
      { name: "ISO 27001", validUntil: "2026-12-31", approved: true },
    ],
    minValue: "100000",
    maxValue: "1000000",
    currency: "USD",
    capacity: "One delivery team is available.",
    evidence: [
      {
        id: "evidence-1",
        name: "Approved capability statement.pdf",
        category: "Company evidence",
        text: "Approved evidence for Atlas Cloud Ltd.",
        approved: true,
        uploadedAt: "2026-04-15T12:00:00Z",
      },
    ],
    autoDraft: true,
    ...overrides,
  };
}

function opportunity(
  overrides: Partial<OpportunityData> = {}
): OpportunityData {
  return {
    ...emptyOpportunity("Cloud modernization"),
    externalId: "CDS-001",
    buyer: "Civic Digital Services",
    country: "United States",
    type: "RFP",
    noticeStatus: "Open",
    solicitationId: "CDS-001",
    url: "https://procurement.example.gov/notices/CDS-001",
    postedAt: "2026-04-28T08:30:00Z",
    dueDate: DUE,
    description:
      "Cloud migration and zero trust services are required for this explicit scope.",
    naics: ["541512"],
    cpv: ["72000000"],
    geographies: ["United States"],
    capabilities: ["cloud migration"],
    value: "500000",
    currency: "USD",
    requiredStatuses: ["Small business"],
    requiredCertifications: ["ISO 27001"],
    eligibilityReviewed: true,
    eligibilityNotes:
      "Reviewed against the official notice and its complete requirements.",
    documents: [solicitationDocument()],
    attachments: [],
    ...overrides,
  };
}

describe("capture matching hardening", () => {
  it("permits an owner-attested company with fully reviewed, current eligibility", () => {
    const result = matchOpportunity(
      company({ capacityVerified: true }),
      opportunity(),
      AS_OF
    );
    expect(result.eligibility).toBe("PASS");
    expect(result.autoDraftAllowed).toBe(true);
  });
  it("uses exact official aliases for SAM status, classifications, and US/United States geography", () => {
    const result = matchOpportunity(company(), opportunity(), AS_OF);

    expect(result.components).toEqual({
      capabilities: 40,
      classification: 20,
      geography: 15,
      buyer: 10,
      evidence: 15,
    });
    expect(result.coverage).toBe(100);
    expect(result.reasons.join(" ")).toContain(
      "fit signal only; not proof of qualification"
    );
    expect(result.reasons.join(" ")).toContain(
      "not treated as proof of eligibility"
    );
    // A narrative capacity statement is deliberately not capacity verification.
    expect(result.eligibility).toBe("UNKNOWN");
    expect(result.autoDraftAllowed).toBe(false);
    expect(result.unknowns).toContain(
      "Delivery capacity needs a current company-owner availability attestation."
    );
  });

  it("keeps a second company with no structured capability, classification, geography, or buyer fit without capability fit", () => {
    const construction = company({
      name: "Northline Construction",
      capabilities: ["civil construction"],
      naics: ["236220"],
      cpv: ["45000000"],
      geographies: ["United Kingdom"],
      preferredBuyers: ["Regional Works Authority"],
    });

    const result = matchOpportunity(construction, opportunity(), AS_OF);
    expect(result.components).toEqual({
      capabilities: 0,
      classification: 0,
      geography: 0,
      buyer: 0,
      evidence: 15,
    });
    expect(result.coverage).toBe(0);
    expect(result.unknowns.join(" ")).toContain(
      "Declared delivery geographies do not match"
    );
  });

  it("recognizes the exact UK/United Kingdom country alias without fuzzy geography matching", () => {
    const result = matchOpportunity(
      company({ geographies: ["UK"] }),
      opportunity({
        country: "United Kingdom",
        geographies: ["United Kingdom"],
      }),
      AS_OF
    );

    expect(result.components.geography).toBe(15);
  });

  it("uses notice term overlap as a labeled fit hypothesis, not verified requirements", () => {
    const result = matchOpportunity(
      company(),
      opportunity({
        capabilities: [],
        description: "Cloud migration appears in this notice body.",
      }),
      AS_OF
    );

    expect(result.components.capabilities).toBe(20);
    expect(result.coverage).toBe(50);
    expect(result.reasons.join(" ")).toContain(
      "Notice keyword fit only (not verified requirements or eligibility)"
    );
  });

  it("requires every listed attachment to be imported by name but permits a reviewed metadata-only notice with scope and no attachments", () => {
    const incomplete = matchOpportunity(
      company(),
      opportunity({
        attachments: [
          {
            name: "Statement of Work.pdf",
            url: "https://procurement.example.gov/files/sow",
          },
          {
            name: "Pricing Schedule.xlsx",
            url: "https://procurement.example.gov/files/pricing",
          },
        ],
        documents: [solicitationDocument("STATEMENT OF WORK.PDF")],
      }),
      AS_OF
    );
    expect(incomplete.eligibility).toBe("UNKNOWN");
    expect(incomplete.autoDraftAllowed).toBe(false);
    expect(incomplete.unknowns).toContain(
      "Full solicitation document set is incomplete: 1 listed attachment is not imported by name."
    );

    const metadataOnly = matchOpportunity(
      company(),
      opportunity({
        documents: [],
        attachments: [],
        eligibilityReviewed: true,
      }),
      AS_OF
    );
    expect(metadataOnly.unknowns.join(" ")).not.toContain(
      "Full solicitation document set is incomplete"
    );
    expect(metadataOnly.unknowns).not.toContain(
      "Solicitation scope text is absent."
    );
  });

  it("makes absent scope, deadline, value, unknown currency, mismatched currency, and absent approved evidence explicit unknowns", () => {
    const noScopeDeadlineValue = matchOpportunity(
      company({ evidence: [] }),
      opportunity({
        description: "",
        documents: [],
        dueDate: "",
        value: null,
        currency: "Unknown",
      }),
      AS_OF
    );
    expect(noScopeDeadlineValue.unknowns).toEqual(
      expect.arrayContaining([
        "Solicitation scope text is absent.",
        "Response deadline is not verified.",
        "Contract value is not published; value capacity cannot be verified.",
        "No approved company evidence is available for drafting.",
      ])
    );

    const unknownCurrency = matchOpportunity(
      company(),
      opportunity({ currency: "Unknown" }),
      AS_OF
    );
    expect(unknownCurrency.unknowns).toContain(
      "Opportunity value currency is unknown."
    );

    const foreignCurrency = matchOpportunity(
      company(),
      opportunity({ currency: "EUR" }),
      AS_OF
    );
    expect(foreignCurrency.unknowns).toContain(
      "Opportunity and company value bounds use different currencies; no FX assumed."
    );
  });

  it("blocks archived companies, expired status attestations, certifications expiring before the response deadline, and financial-cap violations", () => {
    const expired = matchOpportunity(
      company({
        active: false,
        statuses: [
          { name: "Small business", validUntil: "2026-04-30", attested: true },
        ],
        certifications: [
          { name: "ISO 27001", validUntil: "2026-06-01", approved: true },
        ],
      }),
      opportunity(),
      AS_OF
    );
    expect(expired.eligibility).toBe("FAIL");
    expect(expired.blockers).toEqual(
      expect.arrayContaining([
        "Company profile is archived.",
        "Required business status is expired or lacks a current attestation: Small business.",
        "Required certification is expired, unapproved, or does not remain valid through the response deadline: ISO 27001.",
      ])
    );

    expect(
      matchOpportunity(company(), opportunity({ value: "99999" }), AS_OF)
        .blockers
    ).toContain("Opportunity is below company minimum contract value.");
    expect(
      matchOpportunity(company(), opportunity({ value: "1000001" }), AS_OF)
        .blockers
    ).toContain("Opportunity exceeds company maximum contract value.");
  });

  it("rejects invalid dates, duplicate normalized statuses and evidence identities, and oversized evidence names", () => {
    expect(
      profileSchema.safeParse(
        company({
          statuses: [
            { name: "SBA", validUntil: "2026-12-31", attested: true },
            {
              name: "Small business",
              validUntil: "2026-12-31",
              attested: true,
            },
          ],
        })
      ).success
    ).toBe(false);
    expect(
      profileSchema.safeParse(
        company({
          certifications: [
            { name: "ISO 27001", validUntil: "2026-02-30", approved: true },
          ],
        })
      ).success
    ).toBe(false);
    expect(
      profileSchema.safeParse(
        company({
          evidence: [
            { ...company().evidence[0], id: "same", name: "One.pdf" },
            { ...company().evidence[0], id: "same", name: "one pdf" },
          ],
        })
      ).success
    ).toBe(false);
    expect(
      profileSchema.safeParse(
        company({
          evidence: [{ ...company().evidence[0], name: "a".repeat(256) }],
        })
      ).success
    ).toBe(false);
  });

  it("rejects quoted malicious notice URLs and attachment links while allowing empty or public HTTPS URLs", () => {
    const quotedNotice = JSON.parse(
      JSON.stringify({
        ...opportunity(),
        url: "javascript:alert('quoted notice')",
      })
    );
    expect(opportunitySchema.safeParse(quotedNotice).success).toBe(false);
    expect(
      opportunitySchema.safeParse(
        opportunity({ url: "http://procurement.example.gov/notices/CDS-001" })
      ).success
    ).toBe(false);
    expect(
      opportunitySchema.safeParse(
        opportunity({
          attachments: [
            {
              name: "Restricted.pdf",
              url: "https://user:secret@procurement.example.gov/file",
            },
          ],
        })
      ).success
    ).toBe(false);
    expect(
      opportunitySchema.safeParse(
        opportunity({
          url: "",
          attachments: [{ name: "Optional file", url: "" }],
        })
      ).success
    ).toBe(true);
  });

  it("retains the CanadaBuys source kind and catalog entry", () => {
    expect(sourceKindSchema.safeParse("canadabuys").success).toBe(true);
    expect(
      sourceCatalog.some(
        source => source.kind === "canadabuys" && source.name === "CanadaBuys"
      )
    ).toBe(true);
  });
});
