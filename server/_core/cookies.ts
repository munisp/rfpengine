import type { CookieOptions, Request } from "express";
import { isLocalTestMode } from "./localTestMode";

export function getSessionCookieOptions(
  _req: Request,
  env: NodeJS.ProcessEnv = process.env
): CookieOptions {
  if (isLocalTestMode(env)) {
    return { httpOnly: true, path: "/", sameSite: "lax", secure: false };
  }

  // Preview is public HTTPS in a cross-site frame even when the upstream request is HTTP.
  return { httpOnly: true, path: "/", sameSite: "none", secure: true };
}
