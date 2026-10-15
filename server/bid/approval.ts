import { TRPCError } from "@trpc/server";
import type { WorkspaceData } from "../../shared/bid";
import { isVerifiedCitation, isVerifiedRequirement } from "./grounding";

export function validateApprovals(data: WorkspaceData): void {
  const sources = data.documents.filter(
    d => d.approved && d.category.trim().toLowerCase() !== "solicitation"
  );
  if (
    data.documents.some(
      d => d.approved && d.category.trim().toLowerCase() === "solicitation"
    )
  )
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Solicitation documents are reference-only and cannot be approved as company evidence.",
    });
  for (const r of data.requirements) {
    if (r.status !== "Approved") continue;
    if (!isVerifiedRequirement(r, data.documents))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${r.id}: approval requires an exact solicitation source quote.`,
      });
    const mapped = data.sections.find(
      s => s.id === r.section || s.title === r.section
    );
    if (!mapped || !mapped.content.trim())
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${r.id}: map a populated response section before approval.`,
      });
    if (
      !["instructions", "evaluation", "deadline"].includes(
        r.category.trim().toLowerCase()
      ) &&
      !isVerifiedCitation(r.evidence, sources)
    )
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${r.id}: approval requires an exact citation to approved company evidence.`,
      });
  }
  for (const s of data.sections) {
    if (s.status !== "Approved") continue;
    if (
      !s.content.trim() ||
      s.gaps.length ||
      /\[\[Evidence needed:|\[REVIEW REQUIRED|\[.*REQUIRED:/i.test(s.content)
    )
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${s.title}: resolve missing content and substantiation gaps before approval.`,
      });
    if (
      s.citations.length === 0 ||
      s.citations.some(c => !isVerifiedCitation(c, sources))
    )
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${s.title}: approval requires verified approved-company citations.`,
      });
  }
}
