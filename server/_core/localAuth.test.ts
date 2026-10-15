import { describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";
import { COOKIE_NAME } from "@shared/const";
import { publicPlatformConfig, publicPlatformScript } from "./publicConfig";
import { registerLocalTestAuthRoutes } from "./localAuth";
import {
  LOCAL_TEST_OWNER_OPEN_ID,
  LOCAL_TEST_PROJECT_ID,
  LOCAL_TEST_SESSION_MS,
} from "./localTestMode";
import { sdk } from "./sdk";
import { injectLocalTestModeMarker } from "./vite";

type Handler = (req: Request, res: Response) => unknown;

function localEnv(): NodeJS.ProcessEnv {
  return {
    LOCAL_TEST_MODE: "true",
    LOCAL_TEST_PASSWORD: "correct local password",
    MANUS_PROJECT_ID: LOCAL_TEST_PROJECT_ID,
    MANUS_JWT_SECRET: "a-local-test-jwt-secret-that-is-at-least-32-bytes",
  };
}

function routeApp(): {
  app: Express;
  get: Map<string, Handler>;
  post: Map<string, Handler>;
  all: Map<string, Handler>;
} {
  const get = new Map<string, Handler>();
  const post = new Map<string, Handler>();
  const all = new Map<string, Handler>();
  const app = {
    get: (path: string, handler: Handler) => get.set(path, handler),
    post: (path: string, handler: Handler) => post.set(path, handler),
    all: (path: string, handler: Handler) => all.set(path, handler),
  } as unknown as Express;
  return { app, get, post, all };
}

function responseStub() {
  const res = {
    status: vi.fn(),
    set: vi.fn(),
    type: vi.fn(),
    send: vi.fn(),
    json: vi.fn(),
    sendStatus: vi.fn(),
    cookie: vi.fn(),
    redirect: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.set.mockReturnValue(res);
  res.type.mockReturnValue(res);
  return res;
}

function localPostRequest(password: unknown): Request {
  return {
    body: { password },
    headers: { host: "localhost", origin: "http://localhost" },
    get: (header: string) =>
      ({ host: "localhost", origin: "http://localhost" })[header.toLowerCase()],
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as Request;
}

describe("local test authentication", () => {
  it("keeps the login routes unavailable unless the complete opt-in is enabled", async () => {
    const { app, get, post, all } = routeApp();
    registerLocalTestAuthRoutes(app, { env: { LOCAL_TEST_MODE: "false" } });

    const configResponse = responseStub();
    await get.get("/api/local/config")!({} as Request, configResponse as unknown as Response);
    expect(configResponse.json).toHaveBeenCalledWith({ localTestMode: false });

    const loginPageResponse = responseStub();
    await get.get("/local-login")!({} as Request, loginPageResponse as unknown as Response);
    expect(loginPageResponse.sendStatus).toHaveBeenCalledWith(404);

    const loginResponse = responseStub();
    await post.get("/api/local/login")!(
      localPostRequest("anything"),
      loginResponse as unknown as Response
    );
    expect(loginResponse.sendStatus).toHaveBeenCalledWith(404);

    const wrongMethodResponse = responseStub();
    await all.get("/api/local/login")!(
      {} as Request,
      wrongMethodResponse as unknown as Response
    );
    expect(wrongMethodResponse.sendStatus).toHaveBeenCalledWith(404);
  });

  it("rejects non-POST local login methods when local mode is enabled", async () => {
    const { app, all } = routeApp();
    registerLocalTestAuthRoutes(app, { env: localEnv() });
    const res = responseStub();

    await all.get("/api/local/login")!({} as Request, res as unknown as Response);

    expect(res.set).toHaveBeenCalledWith("Allow", "POST");
    expect(res.sendStatus).toHaveBeenCalledWith(405);
  });

  it("rejects a wrong password without a session cookie", async () => {
    const upsertUser = vi.fn();
    const { app, post } = routeApp();
    registerLocalTestAuthRoutes(app, {
      env: localEnv(),
      upsertUser,
      createSessionToken: vi.fn(),
    });

    const res = responseStub();
    await post.get("/api/local/login")!(
      localPostRequest("wrong password"),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.cookie).not.toHaveBeenCalled();
    expect(upsertUser).not.toHaveBeenCalled();
  });

  it("upserts the fixed admin owner and issues an 8-hour HTTP-only local session", async () => {
    const upsertUser = vi.fn().mockResolvedValue(undefined);
    const createSessionToken = vi.fn().mockResolvedValue("signed-session-token");
    const { app, post } = routeApp();
    registerLocalTestAuthRoutes(app, {
      env: localEnv(),
      now: () => 1_700_000_000_000,
      upsertUser,
      createSessionToken,
    });

    const res = responseStub();
    await post.get("/api/local/login")!(
      localPostRequest("correct local password"),
      res as unknown as Response
    );

    expect(upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({
        openId: LOCAL_TEST_OWNER_OPEN_ID,
        name: "Local Test Owner",
        loginMethod: "local-test",
        role: "admin",
      })
    );
    expect(createSessionToken).toHaveBeenCalledWith(LOCAL_TEST_OWNER_OPEN_ID, {
      name: "Local Test Owner",
      expiresInMs: LOCAL_TEST_SESSION_MS,
    });
    expect(res.cookie).toHaveBeenCalledWith(
      COOKIE_NAME,
      "signed-session-token",
      expect.objectContaining({
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: false,
        maxAge: LOCAL_TEST_SESSION_MS,
      })
    );
    expect(res.redirect).toHaveBeenCalledWith(303, "/");
  });

  it("publishes only a boolean local-test setting and injects an HTML marker", () => {
    const env = localEnv();
    const config = publicPlatformConfig(env);
    expect(config.localTestMode).toBe(true);
    expect(config).not.toHaveProperty("LOCAL_TEST_PASSWORD");
    expect(publicPlatformScript(env)).not.toContain(env.LOCAL_TEST_PASSWORD!);
    expect(injectLocalTestModeMarker("<html lang=\"en\"><body></body></html>", env)).toContain(
      'data-local-test="true"'
    );
    expect(injectLocalTestModeMarker("<html><body></body></html>", {})).not.toContain(
      "data-local-test"
    );
  });

  it("uses the existing signed-token verifier and rejects a signature forgery", async () => {
    const env = localEnv();
    const original = {
      projectId: process.env.MANUS_PROJECT_ID,
      secret: process.env.MANUS_JWT_SECRET,
    };
    process.env.MANUS_PROJECT_ID = env.MANUS_PROJECT_ID;
    process.env.MANUS_JWT_SECRET = env.MANUS_JWT_SECRET;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const token = await sdk.createSessionToken(LOCAL_TEST_OWNER_OPEN_ID, {
        name: "Local Test Owner",
        expiresInMs: LOCAL_TEST_SESSION_MS,
      });
      expect(await sdk.verifySession(token)).toMatchObject({
        openId: LOCAL_TEST_OWNER_OPEN_ID,
        appId: LOCAL_TEST_PROJECT_ID,
      });

      const parts = token.split(".");
      const signature = parts[2]!;
      parts[2] = `${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
      expect(await sdk.verifySession(parts.join("."))).toBeNull();
    } finally {
      if (original.projectId === undefined) delete process.env.MANUS_PROJECT_ID;
      else process.env.MANUS_PROJECT_ID = original.projectId;
      if (original.secret === undefined) delete process.env.MANUS_JWT_SECRET;
      else process.env.MANUS_JWT_SECRET = original.secret;
      warn.mockRestore();
    }
  });
});
