import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import express from "express";
import { TRPCError } from "@trpc/server";
import { emptyWorkspace, type Workspace } from "../../shared/bid";
import { responseVolumes } from "./package";
vi.mock("../_core/sdk", () => ({ sdk: { authenticateRequest: vi.fn() } }));
vi.mock("./store", () => ({
  getAccessibleWorkspace: vi.fn(),
  processDeadlineWatch: vi.fn(),
}));
import { sdk } from "../_core/sdk";
import { getAccessibleWorkspace } from "./store";
import { registerBidRoutes } from "./routes";
const workspace: Workspace = {
  id: "fixture",
  version: 7,
  role: "owner",
  updatedAt: "2026-10-15T00:00:00Z",
  data: emptyWorkspace("Package fixture", "RFP"),
};
let server: Server, base: string;
beforeAll(async () => {
  const app = express();
  registerBidRoutes(app);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(() => {
  vi.mocked(sdk.authenticateRequest).mockResolvedValue({
    id: 1,
    openId: "fixture",
    isCron: false,
  } as never);
  vi.mocked(getAccessibleWorkspace).mockResolvedValue({
    workspace,
    role: "owner",
  } as never);
});
it("rejects a ZIP download if the saved version differs from the reviewed checklist", async () => {
  const response = await fetch(
    base + "/api/bid/package/fixture?expectedVersion=6"
  );
  expect(response.status).toBe(409);
  expect((await response.json()).error).toContain("changed");
});
it("returns the actual ZIP at the reviewed version and private cache policy", async () => {
  const response = await fetch(
    base + "/api/bid/package/fixture?expectedVersion=7"
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Workspace-Version")).toBe("7");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const file = new Uint8Array(await response.arrayBuffer());
  expect(Array.from(file.slice(0, 2))).toEqual([80, 75]);
});
it("rejects anonymous, cron and inaccessible-pursuit package access", async () => {
  vi.mocked(sdk.authenticateRequest).mockRejectedValue(
    new TRPCError({ code: "UNAUTHORIZED" })
  );
  expect((await fetch(base + "/api/bid/package/fixture")).status).toBe(401);
  vi.mocked(sdk.authenticateRequest).mockResolvedValue({
    id: 1,
    isCron: true,
  } as never);
  expect((await fetch(base + "/api/bid/package/fixture")).status).toBe(401);
  vi.mocked(sdk.authenticateRequest).mockResolvedValue({
    id: 1,
    isCron: false,
  } as never);
  vi.mocked(getAccessibleWorkspace).mockRejectedValue(
    new TRPCError({ code: "FORBIDDEN" })
  );
  expect((await fetch(base + "/api/bid/package/fixture")).status).toBe(403);
});
it("does not overwrite response volumes whose buyer titles normalize to the same filename", () => {
  const data = emptyWorkspace("Collision fixture");
  data.sections = ["A/B", "A:B", "A-B"].map((title, i) => ({
    id: `s${i}`,
    title,
    guidance: "",
    pageLimit: "",
    owner: "",
    status: "Draft",
    content: `Distinct response ${i}`,
    citations: [],
    gaps: [],
  }));
  const volumes = responseVolumes(data);
  expect(volumes).toHaveLength(3);
  expect(new Set(volumes.map(volume => volume.path)).size).toBe(3);
  expect(
    volumes.flatMap(volume => volume.sections).map(section => section.content)
  ).toEqual([
    "Distinct response 0",
    "Distinct response 1",
    "Distinct response 2",
  ]);
});
