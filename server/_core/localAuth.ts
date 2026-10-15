import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { COOKIE_NAME } from "@shared/const";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import {
  isLocalTestMode,
  LOCAL_TEST_OWNER_OPEN_ID,
  LOCAL_TEST_SESSION_MS,
} from "./localTestMode";
import { sdk } from "./sdk";

const LOCAL_TEST_OWNER_NAME = "Local Test Owner";
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_FAILURES = 8;
const MAX_TRACKED_ADDRESSES = 1_000;

type LoginAttempt = { failures: number; resetAt: number };
type LocalLoginDependencies = {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  upsertUser?: typeof db.upsertUser;
  createSessionToken?: typeof sdk.createSessionToken;
};

function digestPassword(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function passwordMatches(submitted: unknown, expected: string): boolean {
  if (typeof submitted !== "string") return false;
  // Compare fixed-length digests so timing does not reveal password length.
  return timingSafeEqual(digestPassword(submitted), digestPassword(expected));
}

function requestOriginIsSameOrigin(req: Request): boolean {
  const origin = req.get("origin");
  const host = req.get("host");
  if (!origin || !host) return false;

  try {
    const parsed = new URL(origin);
    // Express may sit behind a TLS-terminating local proxy. The Host header is
    // the browser-visible authority, so it remains the stable same-origin key.
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host === host
    );
  } catch {
    return false;
  }
}

function requestAddress(req: Request): string {
  return req.socket.remoteAddress ?? "unknown";
}

function localLoginPage(message?: string): string {
  const notice = message
    ? `<p class="notice" role="alert">${message}</p>`
    : "";
  return `<!doctype html>
<html lang="en" data-local-test="true">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="same-origin">
    <title>BidForge local sign in</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0b1120; color: #e5edf9; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, #1e3a5f 0, #0b1120 52%); }
      main { width: min(100%, 420px); padding: 40px; border: 1px solid #29466b; border-radius: 18px; background: rgba(15, 28, 48, .96); box-shadow: 0 24px 60px rgba(0, 0, 0, .35); }
      .eyebrow { margin: 0 0 10px; color: #7dd3fc; font-size: .8rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
      h1 { margin: 0; font-size: 1.85rem; letter-spacing: -.03em; }
      .intro { margin: 12px 0 28px; color: #b7c6dc; line-height: 1.5; }
      label { display: block; margin-bottom: 8px; font-weight: 650; }
      input { width: 100%; min-height: 48px; padding: 12px 14px; border: 1px solid #42688f; border-radius: 9px; background: #091525; color: inherit; font: inherit; }
      input:focus { outline: 3px solid rgba(56, 189, 248, .35); border-color: #38bdf8; }
      button { width: 100%; min-height: 48px; margin-top: 22px; border: 0; border-radius: 9px; background: #38bdf8; color: #062033; cursor: pointer; font: 700 1rem inherit; }
      button:hover { background: #7dd3fc; }
      .notice { margin: 0 0 20px; padding: 11px 12px; border: 1px solid #fb7185; border-radius: 8px; color: #fecdd3; background: rgba(136, 19, 55, .28); }
      .note { margin: 22px 0 0; color: #8fa6c2; font-size: .84rem; line-height: 1.45; }
    </style>
  </head>
  <body>
    <main aria-labelledby="login-title">
      <p class="eyebrow">BidForge · local test mode</p>
      <h1 id="login-title">Sign in</h1>
      <p class="intro">Use the password configured for this local Compose environment.</p>
      ${notice}
      <form method="post" action="/api/local/login">
        <label for="password">Local test password</label>
        <input id="password" name="password" type="password" required minlength="1" autocomplete="current-password" autofocus>
        <button type="submit">Open BidForge</button>
      </form>
      <p class="note">This sign-in is available only when explicitly enabled for the local test project.</p>
    </main>
  </body>
</html>`;
}

function renderLoginPage(res: Response, status: number, message?: string): void {
  res
    .status(status)
    .set("Cache-Control", "no-store")
    .type("html")
    .send(localLoginPage(message));
}

/**
 * Register the local Compose password login. The routes exist in every build,
 * but return 404 unless the complete LOCAL_TEST_MODE guard is satisfied.
 */
export function registerLocalTestAuthRoutes(
  app: Express,
  dependencies: LocalLoginDependencies = {}
): void {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? Date.now;
  const upsertUser = dependencies.upsertUser ?? db.upsertUser;
  const createSessionToken = dependencies.createSessionToken ?? sdk.createSessionToken.bind(sdk);
  const attempts = new Map<string, LoginAttempt>();

  const enabled = () => isLocalTestMode(env);

  app.get("/api/local/config", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ localTestMode: enabled() });
  });

  app.get("/local-login", (req, res) => {
    if (!enabled()) {
      res.sendStatus(404);
      return;
    }
    renderLoginPage(res, 200);
  });

  app.post("/api/local/login", async (req, res) => {
    if (!enabled()) {
      res.sendStatus(404);
      return;
    }
    if (!requestOriginIsSameOrigin(req)) {
      renderLoginPage(res, 403, "Sign-in request was not from this site.");
      return;
    }

    const address = requestAddress(req);
    const timestamp = now();
    const prior = attempts.get(address);
    if (prior && prior.resetAt <= timestamp) attempts.delete(address);
    const current = attempts.get(address);
    if (current && current.failures >= MAX_LOGIN_FAILURES) {
      renderLoginPage(res, 429, "Too many attempts. Please wait and try again.");
      return;
    }

    const expectedPassword = env.LOCAL_TEST_PASSWORD!;
    if (!passwordMatches(req.body?.password, expectedPassword)) {
      if (!current && attempts.size >= MAX_TRACKED_ADDRESSES) {
        const oldestAddress = attempts.keys().next().value;
        if (oldestAddress) attempts.delete(oldestAddress);
      }
      attempts.set(address, {
        failures: (current?.failures ?? 0) + 1,
        resetAt: timestamp + LOGIN_WINDOW_MS,
      });
      renderLoginPage(res, 401, "Password was not accepted.");
      return;
    }

    attempts.delete(address);
    try {
      const signedInAt = new Date(timestamp);
      await upsertUser({
        openId: LOCAL_TEST_OWNER_OPEN_ID,
        name: LOCAL_TEST_OWNER_NAME,
        email: null,
        loginMethod: "local-test",
        role: "admin",
        lastSignedIn: signedInAt,
      });
      const sessionToken = await createSessionToken(LOCAL_TEST_OWNER_OPEN_ID, {
        name: LOCAL_TEST_OWNER_NAME,
        expiresInMs: LOCAL_TEST_SESSION_MS,
      });
      res.cookie(COOKIE_NAME, sessionToken, {
        ...getSessionCookieOptions(req, env),
        maxAge: LOCAL_TEST_SESSION_MS,
      });
      res.redirect(303, "/");
    } catch (error) {
      // Never reveal configuration, database, or signing details on a login page.
      console.error(
        "[LocalAuth] Local test login failed:",
        error instanceof Error ? error.message : "unknown error"
      );
      renderLoginPage(res, 500, "Sign-in is temporarily unavailable.");
    }
  });

  app.all("/api/local/login", (_req, res) => {
    if (!enabled()) {
      res.sendStatus(404);
      return;
    }
    res.set("Allow", "POST").sendStatus(405);
  });

  app.all("/local-login", (_req, res) => {
    if (!enabled()) {
      res.sendStatus(404);
      return;
    }
    res.set("Allow", "GET").sendStatus(405);
  });
}
