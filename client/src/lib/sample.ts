import {
  emptyWorkspace,
  type Workspace,
  type WorkspaceData,
} from "@shared/bid";

const base = emptyWorkspace("Enterprise cloud modernization");
export const sampleData: WorkspaceData = {
  ...base,
  customer: "Department of Transportation",
  solicitationId: "DOT-26-1048",
  value: 4800000,
  dueDate: "2026-11-06",
  owner: "Alex Morgan",
  stage: "Drafting",
  description:
    "A secure, phased modernization of legacy enterprise infrastructure with a resilient cloud operating model and measurable service outcomes.",
  documents: [
    {
      id: "d1",
      name: "DOT_Cloud_Modernization_RFP.pdf",
      category: "Solicitation",
      approved: false,
      uploadedAt: "2026-10-10",
      text: "SAMPLE SOLICITATION — NOT AN ACTUAL GOVERNMENT NOTICE\nL.1: Technical response shall include a phased migration approach and rollback plan. Maximum 20 pages.\nL.2: Provide a staffing plan with named key personnel and qualifications.\nL.3: Price shall be submitted in a separate volume with labor categories and assumptions.\nM.1: Technical approach will be evaluated for migration risk, operational resilience and measurable outcomes.\nC.4: Describe alignment to NIST SP 800-53 controls and provide supporting evidence.\nC.5: Provide 24/7 monitoring and incident escalation procedures.\nC.6: Provide two relevant past performance examples from the last five years.\nL.4: Proposals are due November 6, 2026. Questions are due October 19, 2026.",
    },
    {
      id: "d2",
      name: "Cloud delivery capabilities.md",
      category: "Capabilities",
      approved: true,
      uploadedAt: "2026-10-09",
      text: "SAMPLE COMPANY EVIDENCE\nOur cloud migration approach uses discovery, pilot migration, staged cutover and stabilization. Each stage has documented entry and exit criteria. Rollback procedures are rehearsed before production cutover. We establish an operations runbook with monitoring and incident escalation.",
    },
    {
      id: "d3",
      name: "Transit modernization case study.md",
      category: "Past performance",
      approved: true,
      uploadedAt: "2026-10-09",
      text: "SAMPLE COMPANY EVIDENCE\nA regional transit modernization engagement included dependency mapping, a non-production pilot and a phased migration. The case study does not substantiate specific savings or uptime guarantees. References require client permission.",
    },
  ],
  requirements: [
    {
      id: "R-001",
      text: "Phased migration approach and rollback plan",
      category: "Technical",
      reference: "RFP § L.1",
      quote:
        "Technical response shall include a phased migration approach and rollback plan.",
      section: "Technical approach",
      owner: "Alex Morgan",
      evidence: "Cloud delivery capabilities.md",
      status: "Approved",
      mandatory: true,
    },
    {
      id: "R-002",
      text: "Named key personnel and qualifications",
      category: "Management",
      reference: "RFP § L.2",
      quote:
        "Provide a staffing plan with named key personnel and qualifications.",
      section: "Management & staffing",
      owner: "Jordan Lee",
      evidence: "",
      status: "Missing",
      mandatory: true,
    },
    {
      id: "R-003",
      text: "Separate price volume with labor assumptions",
      category: "Pricing",
      reference: "RFP § L.3",
      quote:
        "Price shall be submitted in a separate volume with labor categories and assumptions.",
      section: "Price narrative",
      owner: "Sam Rivera",
      evidence: "",
      status: "Drafted",
      mandatory: true,
    },
    {
      id: "R-004",
      text: "NIST SP 800-53 alignment with evidence",
      category: "Security",
      reference: "RFP § C.4",
      quote:
        "Describe alignment to NIST SP 800-53 controls and provide supporting evidence.",
      section: "Security & compliance",
      owner: "Jordan Lee",
      evidence: "",
      status: "Missing",
      mandatory: true,
    },
    {
      id: "R-005",
      text: "24/7 monitoring and incident escalation",
      category: "Operations",
      reference: "RFP § C.5",
      quote: "Provide 24/7 monitoring and incident escalation procedures.",
      section: "Technical approach",
      owner: "Alex Morgan",
      evidence: "Cloud delivery capabilities.md",
      status: "In review",
      mandatory: true,
    },
    {
      id: "R-006",
      text: "Two relevant past performance examples",
      category: "Experience",
      reference: "RFP § C.6",
      quote:
        "Provide two relevant past performance examples from the last five years.",
      section: "Past performance",
      owner: "Taylor Chen",
      evidence: "Transit modernization case study.md",
      status: "Drafted",
      mandatory: true,
    },
    {
      id: "R-007",
      text: "Technical volume limited to 20 pages",
      category: "Instructions",
      reference: "RFP § L.1",
      quote: "Maximum 20 pages.",
      section: "Technical approach",
      owner: "Alex Morgan",
      evidence: "DOT_Cloud_Modernization_RFP.pdf",
      status: "Approved",
      mandatory: true,
    },
    {
      id: "R-008",
      text: "Address operational resilience and measurable outcomes",
      category: "Evaluation",
      reference: "RFP § M.1",
      quote:
        "Technical approach will be evaluated for migration risk, operational resilience and measurable outcomes.",
      section: "Technical approach",
      owner: "Alex Morgan",
      evidence: "Cloud delivery capabilities.md",
      status: "In review",
      mandatory: false,
    },
  ],
  sections: [
    {
      id: "s1",
      title: "Executive summary",
      guidance:
        "Connect customer priorities to a credible delivery approach. Do not invent quantified benefits.",
      pageLimit: "Not specified",
      owner: "Alex Morgan",
      status: "Draft",
      content:
        "## A controlled path to cloud modernization\n\nOur proposed approach puts migration risk and operational continuity at the center of delivery. We begin with dependency discovery, validate the approach in a pilot, and move through staged cutovers with defined entry and exit criteria.\n\nEach migration stage includes rehearsed rollback procedures and an operations runbook. This creates a clear basis for customer review before production changes.\n\n**To substantiate before submission:** confirm staffing commitments, service levels, and the customer-approved measures of success.",
      citations: ["Cloud delivery capabilities.md"],
      gaps: ["Confirm measurable outcomes with the delivery team."],
    },
    {
      id: "s2",
      title: "Technical approach",
      guidance:
        "Explain discovery, pilot, cutover, rollback and stabilization. Address evaluation factor M.1.",
      pageLimit: "20 pages (technical volume)",
      owner: "Alex Morgan",
      status: "In review",
      content:
        "## Phased migration with explicit decision gates\n\nWe use a four-stage delivery model: discovery, pilot migration, staged cutover, and stabilization. Each stage has documented entry and exit criteria. Rollback procedures are rehearsed before production cutover.\n\n### Operational transition\nAn operations runbook defines monitoring and incident escalation.\n\n[REVIEW REQUIRED: the approved evidence does not substantiate 24/7 staffing or specific response times.]",
      citations: ["Cloud delivery capabilities.md"],
      gaps: ["24/7 monitoring coverage is not substantiated."],
    },
    {
      id: "s3",
      title: "Management & staffing",
      guidance: "Include named key personnel and verified qualifications.",
      pageLimit: "Not specified",
      owner: "Jordan Lee",
      status: "Not started",
      content: "",
      citations: [],
      gaps: ["Approved resumes and availability are required."],
    },
    {
      id: "s4",
      title: "Security & compliance",
      guidance:
        "Map the proposed solution to applicable NIST controls; distinguish plans from certifications.",
      pageLimit: "Not specified",
      owner: "Jordan Lee",
      status: "Not started",
      content: "",
      citations: [],
      gaps: [
        "Provide an approved control mapping and supporting security policies.",
      ],
    },
    {
      id: "s5",
      title: "Past performance",
      guidance:
        "Provide two relevant examples, verified dates, scope and authorized references.",
      pageLimit: "Not specified",
      owner: "Taylor Chen",
      status: "Draft",
      content:
        "## Relevant delivery experience\n\nThe regional transit modernization engagement included dependency mapping, a non-production pilot, and a phased migration.\n\n[REVIEW REQUIRED: add verified performance dates and authorized client reference.]\n\n[SECOND EXAMPLE REQUIRED: no second approved case study is available.]",
      citations: ["Transit modernization case study.md"],
      gaps: [
        "Second relevant example missing.",
        "Dates and reference permission need verification.",
      ],
    },
    {
      id: "s6",
      title: "Price narrative",
      guidance:
        "Separate price volume. Document labor categories, assumptions and exclusions.",
      pageLimit: "Separate volume",
      owner: "Sam Rivera",
      status: "Draft",
      content:
        "## Pricing basis\n\nPricing scenarios use explicit labor, other direct cost, overhead and gross-margin assumptions. These are planning estimates, not an authorized offer.\n\n[REVIEW REQUIRED: confirm labor categories, contract term, escalation, rates and cost basis before final pricing.]",
      citations: [],
      gaps: ["Validated rate card and period of performance required."],
    },
  ],
  strategy: {
    priorities: [
      "Minimize migration risk and disruption",
      "Demonstrate operational resilience",
      "Make service outcomes measurable",
    ],
    winThemes: [
      "A phased transition, not a big-bang migration",
      "Decision gates that give the customer control",
      "Evidence before promises",
    ],
    discriminators: [
      "Rehearsed rollback at each production cutover — supported by delivery methodology",
      "Transit-domain delivery experience — verify scope and dates before use",
    ],
    risks: [
      "NIST control evidence is missing",
      "Named personnel and availability are not verified",
      "Only one past-performance example is available",
    ],
    questions: [
      "What are the required service-level measures and acceptance criteria?",
      "Is a prescribed NIST control baseline applicable?",
      "Will transition work require after-hours cutovers?",
    ],
  },
  milestones: [
    {
      id: "m1",
      title: "Bid / no-bid decision",
      date: "2026-10-12",
      done: true,
    },
    {
      id: "m2",
      title: "Questions to the buyer",
      date: "2026-10-19",
      done: false,
    },
    { id: "m3", title: "Pink team review", date: "2026-10-23", done: false },
    { id: "m4", title: "Red team review", date: "2026-10-30", done: false },
    { id: "m5", title: "Final response due", date: "2026-11-06", done: false },
  ],
  scenarios: [
    {
      id: "p1",
      name: "Balanced",
      labor: 2350000,
      other: 350000,
      overhead: 22,
      margin: 18,
      competitorLow: 3700000,
      competitorHigh: 4400000,
      rationale:
        "Balance delivery resilience with a competitive planning price. No validated competitor pricing is available.",
      assumptions:
        "Illustrative 3-year delivery scope. Labor and direct costs are unvalidated. Market range is a hypothesis, not observed bid data.",
    },
    {
      id: "p2",
      name: "Competitive",
      labor: 2200000,
      other: 300000,
      overhead: 20,
      margin: 14,
      competitorLow: 3700000,
      competitorHigh: 4400000,
      rationale:
        "Lower margin and leaner staffing; confirm this staffing still satisfies requirements.",
      assumptions:
        "Planning scenario only. Lower staffing creates delivery risk and requires solution review.",
    },
    {
      id: "p3",
      name: "Value-led",
      labor: 2500000,
      other: 400000,
      overhead: 24,
      margin: 22,
      competitorLow: 3700000,
      competitorHigh: 4400000,
      rationale:
        "Invest in transition capacity; stronger value substantiation is needed for a premium price.",
      assumptions:
        "Planning scenario only. Additional transition capacity has not been priced using a verified rate card.",
    },
  ],
  comments: [
    {
      id: "c1",
      author: "Jordan Lee",
      content:
        "We need the control mapping and approved resumes before the red team review.",
      at: "2026-10-12T14:30:00Z",
    },
  ],
  activity: [
    {
      id: "a1",
      message: "Technical approach sent for review",
      at: "2026-10-12T15:30:00Z",
    },
    {
      id: "a2",
      message: "Eight requirements mapped from the sample RFP",
      at: "2026-10-12T13:00:00Z",
    },
  ],
  quality: [
    {
      severity: "Critical",
      message: "Named personnel and security control evidence are missing.",
      reference: "R-002, R-004",
    },
    {
      severity: "Warning",
      message: "A second past-performance example is required.",
      reference: "R-006",
    },
  ],
};
export const sampleWorkspaces: Workspace[] = [
  {
    id: "sample-cloud",
    version: 1,
    data: sampleData,
    role: "owner",
    updatedAt: "2026-10-12T15:30:00Z",
  },
  {
    id: "sample-health",
    version: 1,
    role: "owner",
    updatedAt: "2026-10-11T11:00:00Z",
    data: {
      ...emptyWorkspace("Digital patient experience", "RFI"),
      customer: "Northstar Health",
      value: 1200000,
      dueDate: "2026-11-13",
      owner: "Taylor Chen",
      stage: "Analyzing",
    },
  },
  {
    id: "sample-cyber",
    version: 1,
    role: "owner",
    updatedAt: "2026-10-10T11:00:00Z",
    data: {
      ...emptyWorkspace("Cybersecurity operations support", "Sources sought"),
      customer: "Federal civilian agency",
      value: 2500000,
      dueDate: "2026-11-20",
      owner: "Jordan Lee",
      stage: "Qualifying",
    },
  },
  {
    id: "sample-data",
    version: 1,
    role: "owner",
    updatedAt: "2026-10-09T11:00:00Z",
    data: {
      ...emptyWorkspace("Data platform & analytics", "RFP"),
      customer: "Meridian Utilities",
      value: 1800000,
      dueDate: "2026-11-27",
      owner: "Sam Rivera",
      stage: "In review",
    },
  },
];
