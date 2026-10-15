import { describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const env = vi.hoisted(() => ({ databaseReads: 0 }));
vi.mock("../db", () => ({
  getDb: vi.fn(async () => {
    env.databaseReads++;
    throw Error("The classifier must not access a database.");
  }),
}));

import { classifyPipelineError } from "./pipeline";

describe("capture pipeline error classification", () => {
  it("makes access failures terminal and never retains an upstream response body", () => {
    const failure = classifyPipelineError(
      Object.assign(
        new Error("Authorization: Bearer secret-token from remote source"),
        { status: 403 }
      )
    );
    expect(failure).toEqual({
      message:
        "Source access was denied. Verify authorized source access and retry manually.",
      retryable: false,
      leaseLost: false,
    });
    expect(failure.message).not.toContain("secret-token");
    expect(env.databaseReads).toBe(0);
  });

  it("does not retry stale eligibility or version conflicts", () => {
    const failure = classifyPipelineError(
      new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "profile disabled during a draft",
      })
    );
    expect(failure.retryable).toBe(false);
    expect(failure.leaseLost).toBe(false);
    expect(failure.message).not.toContain("profile disabled");
    expect(env.databaseReads).toBe(0);
  });

  it("keeps safe SourceAccessError codes while redacting their original body", () => {
    const sourceError = Object.assign(
      new Error("SAM key abc123 should never be stored"),
      {
        name: "SourceAccessError",
        code: "SAM_API_KEY_REQUIRED",
        retryable: false,
      }
    );
    const failure = classifyPipelineError(sourceError);
    expect(failure).toMatchObject({
      message:
        "Source error [SAM_API_KEY_REQUIRED]; review authorized source access or configuration before retrying.",
      retryable: false,
      leaseLost: false,
    });
    expect(failure.message).not.toContain("abc123");
  });

  it("preserves only a bounded structural retry-after value for retryable source failures", () => {
    const sourceError = Object.assign(new Error("remote response body"), {
      name: "SourceAccessError",
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterSeconds: 900,
    });
    expect(classifyPipelineError(sourceError)).toEqual({
      message:
        "Source error [RATE_LIMITED]; retrying without retaining upstream details.",
      retryable: true,
      leaseLost: false,
      retryAfterSeconds: 900,
    });
  });

  it("keeps unknown transport failures retryable with a redacted message", () => {
    const failure = classifyPipelineError(
      new Error("upstream included api_key=not-for-storage")
    );
    expect(failure).toEqual({
      message:
        "Pipeline operation failed without exposing upstream details; it will retry when safe.",
      retryable: true,
      leaseLost: false,
    });
    expect(env.databaseReads).toBe(0);
  });
});
