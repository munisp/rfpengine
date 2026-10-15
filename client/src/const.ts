import { OAUTH_STATE_COOKIE, encodeOAuthState } from "@shared/const";

export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

function localTestLoginEnabled(): boolean {
  // Do not trust a mutable runtime config object to enable password auth. This
  // marker is emitted only by Express after the complete server-side guard.
  return typeof document !== "undefined" && document.documentElement.dataset.localTest === "true";
}

/**
 * Return the current login destination. In local Compose mode this is the
 * explicit password form; otherwise this creates the OAuth state and URL.
 * Call only from an action/effect because the OAuth branch writes a nonce cookie.
 */
export const getLoginUrl = (): string => {
  if (localTestLoginEnabled()) return "/local-login";

  const oauthPortalUrl = window.__MANUS_CONFIG__?.oauthPortalUrl;
  const appId = window.__MANUS_CONFIG__?.projectId;
  if (!oauthPortalUrl || !appId) throw new Error("Manus login is not configured");
  const redirectUri = `${window.location.origin}/api/oauth/callback`;

  const nonce = crypto.randomUUID();
  document.cookie = `${OAUTH_STATE_COOKIE}=${nonce}; Path=/; Max-Age=600; SameSite=None; Secure`;
  const state = encodeOAuthState({ redirectUri, nonce });

  const url = new URL(`${oauthPortalUrl}/app-auth`);
  url.searchParams.set("appId", appId);
  url.searchParams.set("redirectUri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("responseType", "code");
  return url.toString();
};

// Start the configured login. Call this from an event handler or effect at the
// moment you want to navigate, e.g. `onClick={() => startLogin()}`.
//
// The hosted OAuth branch mints a one-time nonce and writes the state cookie.
// Do NOT call it during render: a stray render-phase call could overwrite an
// in-flight OAuth nonce and make its callback reject with "invalid oauth state".
export const startLogin = () => {
  window.location.href = getLoginUrl();
};
