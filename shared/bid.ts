import { z } from "zod";

export const requirementSchema = z.object({
  id: z.string(),
  text: z.string(),
  category: z.string(),
  reference: z.string(),
  quote: z.string(),
  section: z.string(),
  owner: z.string(),
  evidence: z.string(),
  status: z.enum(["Missing", "Drafted", "In review", "Approved"]),
  mandatory: z.boolean(),
});
export const sectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  guidance: z.string(),
  pageLimit: z.string(),
  owner: z.string(),
  content: z.string(),
  status: z.enum(["Not started", "Draft", "In review", "Approved"]),
  citations: z.array(z.string()),
  gaps: z.array(z.string()),
});
export const documentSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  text: z.string(),
  approved: z.boolean(),
  uploadedAt: z.string(),
});
export const scenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  labor: z.number().nonnegative(),
  other: z.number().nonnegative(),
  overhead: z.number().min(0).max(100),
  margin: z.number().min(0).max(95),
  competitorLow: z.number().nonnegative(),
  competitorHigh: z.number().nonnegative(),
  rationale: z.string(),
  assumptions: z.string(),
});
export const workspaceDataSchema = z.object({
  name: z.string().min(1).max(200),
  customer: z.string().max(200),
  type: z.enum(["RFP", "RFI", "Sources sought"]),
  solicitationId: z.string().max(200),
  value: z.number().nonnegative(),
  dueDate: z.string(),
  owner: z.string(),
  stage: z.enum([
    "Qualifying",
    "Analyzing",
    "Drafting",
    "In review",
    "Ready",
    "Submitted",
  ]),
  description: z.string(),
  requirements: z.array(requirementSchema),
  sections: z.array(sectionSchema),
  documents: z.array(documentSchema),
  strategy: z.object({
    priorities: z.array(z.string()),
    winThemes: z.array(z.string()),
    discriminators: z.array(z.string()),
    risks: z.array(z.string()),
    questions: z.array(z.string()),
  }),
  milestones: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      date: z.string(),
      done: z.boolean(),
    })
  ),
  scenarios: z.array(scenarioSchema),
  comments: z.array(
    z.object({
      id: z.string(),
      author: z.string(),
      content: z.string(),
      at: z.string(),
    })
  ),
  activity: z.array(
    z.object({ id: z.string(), message: z.string(), at: z.string() })
  ),
  quality: z.array(
    z.object({
      severity: z.enum(["Critical", "Warning", "Info"]),
      message: z.string(),
      reference: z.string(),
    })
  ),
});
export type WorkspaceData = z.infer<typeof workspaceDataSchema>;
export type Requirement = z.infer<typeof requirementSchema>;
export type ResponseSection = z.infer<typeof sectionSchema>;
export type EvidenceDocument = z.infer<typeof documentSchema>;
export type PriceScenario = z.infer<typeof scenarioSchema>;
export type Workspace = {
  id: string;
  version: number;
  data: WorkspaceData;
  role: "owner" | "editor" | "reviewer";
  updatedAt: string;
};
export function priceScenario(s: PriceScenario) {
  const direct = s.labor + s.other;
  const cost = direct * (1 + s.overhead / 100);
  const price = cost / (1 - s.margin / 100);
  return {
    direct,
    cost,
    price,
    profit: price - cost,
    inRange: price >= s.competitorLow && price <= s.competitorHigh,
  };
}
export function readiness(data: WorkspaceData) {
  const approved = data.requirements.filter(
    r => r.status === "Approved"
  ).length;
  return {
    approved,
    total: data.requirements.length,
    coverage: data.requirements.length
      ? Math.round((approved / data.requirements.length) * 100)
      : 0,
    gaps: data.requirements.filter(r => !r.evidence || r.status === "Missing")
      .length,
    sectionsApproved: data.sections.filter(s => s.status === "Approved").length,
  };
}
export function emptyWorkspace(
  name: string,
  type: WorkspaceData["type"] = "RFP"
): WorkspaceData {
  return {
    name,
    type,
    customer: "",
    solicitationId: "",
    value: 0,
    dueDate: "",
    owner: "",
    stage: "Qualifying",
    description: "",
    requirements: [],
    sections: [],
    documents: [],
    strategy: {
      priorities: [],
      winThemes: [],
      discriminators: [],
      risks: [],
      questions: [],
    },
    milestones: [],
    scenarios: [],
    comments: [],
    activity: [],
    quality: [],
  };
}
