import { describe, it, expect, vi, beforeEach } from "vitest";
import { exampleBaseline, uniformStress } from "../../shared/erosion";
vi.mock("./store", () => ({
  listBaselines: vi.fn(),
  detail: vi.fn(),
  createBaseline: vi.fn(),
  evaluate: vi.fn(),
  saveCase: vi.fn(),
  exportCsv: vi.fn(),
}));
import * as store from "./store";
import { appRouter } from "../routers";
const context = (user: boolean) =>
  ({
    user: user
      ? {
          id: 7,
          openId: "test",
          name: "Test",
          email: "test@example.invalid",
          role: "user",
        }
      : null,
    req: {},
    res: {},
  }) as any;
describe("registered fixed-bid tRPC routes", () => {
  beforeEach(() => vi.clearAllMocks());
  it("requires authentication for list", async () =>
    await expect(
      appRouter.createCaller(context(false)).erosion.list({ workspaceId: "w" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" }));
  it("forwards workspace and authenticated actor, never client actor", async () => {
    vi.mocked(store.listBaselines).mockResolvedValue([]);
    await appRouter
      .createCaller(context(true))
      .erosion.list({ workspaceId: "w" });
    expect(store.listBaselines).toHaveBeenCalledWith("w", 7);
  });
  it("registers create and validates a positive fixed price", async () => {
    await expect(
      appRouter
        .createCaller(context(true))
        .erosion.create({
          workspaceId: "w",
          requestKey: "abcdefgh",
          baseline: { ...exampleBaseline, bidPrice: "0" },
        })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(store.createBaseline).not.toHaveBeenCalled();
  });
  it("rejects revisions without a rationale", async () =>
    await expect(
      appRouter
        .createCaller(context(true))
        .erosion.revise({
          workspaceId: "w",
          previousId: "b",
          requestKey: "abcdefgh",
          baseline: exampleBaseline,
          reason: "",
        })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" }));
  it("forwards stress evaluation to the scoped baseline", async () => {
    vi.mocked(store.evaluate).mockResolvedValue({} as any);
    await appRouter
      .createCaller(context(true))
      .erosion.evaluate({
        workspaceId: "w",
        baselineId: "b",
        stress: uniformStress(10),
      });
    expect(store.evaluate).toHaveBeenCalledWith("w", "b", uniformStress(10), 7);
  });
  it("validates idempotency keys", async () =>
    await expect(
      appRouter
        .createCaller(context(true))
        .erosion.saveCase({
          workspaceId: "w",
          baselineId: "b",
          requestKey: "bad key",
          stress: uniformStress(10),
        })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" }));
  it("exports only scoped detail", async () => {
    vi.mocked(store.detail).mockResolvedValue({} as any);
    vi.mocked(store.exportCsv).mockReturnValue("csv");
    const out = await appRouter
      .createCaller(context(true))
      .erosion.export({ workspaceId: "w", baselineId: "b" });
    expect(store.detail).toHaveBeenCalledWith("w", "b", 7);
    expect(out.content).toBe("csv");
  });
});
