import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { getOpportunity, updateOpportunity } from "./store";
import { publicFetch, SourceAccessError } from "./network";
import {
  extractEvidenceText,
  EvidenceExtractionError,
} from "../bid/extraction";
import { analyzeEvidence } from "../bid/ai";

export async function importLinkedAttachment(
  owner: number,
  input: { opportunityId: string; version: number; attachmentName: string }
) {
  const opportunity = await getOpportunity(owner, input.opportunityId);
  if (opportunity.version !== input.version)
    throw new TRPCError({
      code: "CONFLICT",
      message: "Opportunity changed; reload before importing this attachment.",
    });
  const attachment = opportunity.data.attachments.find(
    a => a.name === input.attachmentName
  );
  if (!attachment?.url)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "A published attachment URL with this name was not found.",
    });
  let text: string;
  try {
    const response = await publicFetch(attachment.url, {
      maxBytes: 10 * 1024 * 1024,
    });
    const mime =
      response.headers.get("content-type")?.split(";")[0] ||
      "application/octet-stream";
    text = await extractEvidenceText({
      name: attachment.name,
      mime,
      base64: response.body.toString("base64"),
    });
  } catch (e) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        e instanceof EvidenceExtractionError
          ? e.message
          : e instanceof SourceAccessError
            ? "Attachment is not publicly readable or exceeded the download limits. Import an authorized local file instead."
            : "Attachment import failed; use an authorized local file.",
    });
  }
  const documents = opportunity.data.documents.filter(
    d => d.name !== attachment.name
  );
  documents.push({
    id: randomUUID(),
    name: attachment.name,
    category: "Solicitation",
    approved: false,
    text,
    uploadedAt: new Date().toISOString(),
  });
  return updateOpportunity(owner, opportunity.id, input.version, {
    documents,
    eligibilityReviewed: false,
  });
}
export async function analyzeOpportunity(owner: number, id: string) {
  const opportunity = await getOpportunity(owner, id);
  const documents = [...opportunity.data.documents];
  if (opportunity.data.description.trim())
    documents.unshift({
      id: "notice-" + opportunity.id,
      name: opportunity.data.title + " · source notice",
      category: "Solicitation",
      approved: false,
      text: opportunity.data.description,
      uploadedAt: new Date().toISOString(),
    });
  if (!documents.length)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Import solicitation text before AI analysis.",
    });
  const result = await analyzeEvidence(
    documents.map(d => ({ ...d, category: "Solicitation" }))
  );
  return {
    opportunityId: id,
    opportunityVersion: opportunity.version,
    requirements: result.analysis.requirements,
    sections: result.analysis.sections,
    strategy: result.analysis.strategy,
    deadlines: result.analysis.deadlines,
    issues: result.issues,
  };
}
