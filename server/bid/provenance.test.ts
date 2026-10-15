import { describe, expect, it } from "vitest";
import {
  emptyWorkspace,
  type EvidenceDocument,
  type WorkspaceData,
} from "../../shared/bid";
import { emptyProfile } from "../../shared/capture";
import type { CapturedProfileBinding } from "./grounding";
import { scopeCapturedWorkspaceEvidence } from "./store";

const binding = (profileId: string, profileVersion: number, name: string) => {
  const profile = {
    ...emptyProfile(name),
    evidence: [
      {
        id: "capability-source",
        name: "Capability statement",
        category: "Company evidence",
        text: `${name} delivers the required engineering capability.`,
        approved: true,
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  return {
    profileId,
    profileVersion,
    profileSnapshot: profile,
  } satisfies CapturedProfileBinding;
};

const frozenDocument = (
  source: CapturedProfileBinding,
  id = "workspace-copy"
): EvidenceDocument => ({
  id,
  name: `${source.profileSnapshot.name} · Capability statement`,
  category: "Company evidence",
  text: source.profileSnapshot.evidence[0].text,
  approved: true,
  uploadedAt: "2026-01-02T00:00:00.000Z",
  provenance: {
    kind: "capture-profile",
    profileId: source.profileId,
    profileVersion: source.profileVersion,
    profileEvidenceId: "capability-source",
  },
});

const withDocuments = (documents: EvidenceDocument[]): WorkspaceData => ({
  ...emptyWorkspace("Captured pursuit"),
  documents,
});

describe("captured profile evidence isolation", () => {
  const companyA = binding("profile-company-a", 3, "Company A");
  const companyB = binding("profile-company-b", 7, "Company B");

  it("rejects a Company B frozen source when it is saved into Company A's captured response", () => {
    expect(() =>
      scopeCapturedWorkspaceEvidence(
        withDocuments([frozenDocument(companyB)]),
        emptyWorkspace("Captured pursuit"),
        companyA
      )
    ).toThrow("another company profile");
  });

  it("allows same-profile reuse only as a new review-required source", () => {
    const saved = scopeCapturedWorkspaceEvidence(
      withDocuments([frozenDocument(companyA)]),
      emptyWorkspace("Captured pursuit"),
      companyA
    );

    expect(saved.documents).toHaveLength(1);
    expect(saved.documents[0]).toMatchObject({
      approved: false,
      provenance: {
        kind: "capture-profile",
        profileId: "profile-company-a",
        profileVersion: 3,
        profileEvidenceId: "capability-source",
      },
    });
  });

  it("keeps exact legacy frozen profile evidence through a restored version and attaches verified provenance", () => {
    const legacy = frozenDocument(companyA);
    delete legacy.provenance;
    const restored = scopeCapturedWorkspaceEvidence(
      withDocuments([legacy]),
      emptyWorkspace("Captured pursuit"),
      companyA
    );

    expect(restored.documents[0]).toMatchObject({
      approved: true,
      provenance: {
        profileId: "profile-company-a",
        profileVersion: 3,
        profileEvidenceId: "capability-source",
      },
    });
  });

  it("downgrades a newly added source with unknown provenance instead of auto-approving it", () => {
    const manual: EvidenceDocument = {
      id: "manual-source",
      name: "Interview notes.txt",
      category: "Knowledge note",
      text: "A source that has not been mapped to the frozen profile.",
      approved: true,
      uploadedAt: "2026-01-03T00:00:00.000Z",
    };
    const saved = scopeCapturedWorkspaceEvidence(
      withDocuments([manual]),
      emptyWorkspace("Captured pursuit"),
      companyA
    );
    expect(saved.documents[0]).toMatchObject({
      id: "manual-source",
      approved: false,
    });
  });
});
