import { lookup as dnsLookup } from "node:dns/promises";
import { Agent, request } from "undici";
import ipaddr from "ipaddr.js";

const MAX_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
]);
const CONTRACTS_FINDER_HOST = "www.contractsfinder.service.gov.uk";

type FetchMethod = "GET" | "POST";

export type PublicFetchOptions = {
  method?: FetchMethod;
  headers?: HeadersInit;
  jsonBody?: unknown;
  /** Clamped to 20 seconds, including DNS resolution and redirects. */
  timeoutMs?: number;
  /** Clamped to 12 MiB of received response bytes. */
  maxBytes?: number;
  /** Exact host names permitted for this request and every redirect. */
  allowedHosts?: readonly string[];
};

export class SourceAccessError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  /** Backwards-compatible alias for retryAfterSeconds. */
  readonly rateRetry?: number;

  constructor(
    code: string,
    message = "The source could not be read.",
    rateRetry?: number
  ) {
    super(message);
    this.name = "SourceAccessError";
    this.code = code;
    this.retryable = [
      "RATE_LIMITED",
      "TIMEOUT",
      "NETWORK_ERROR",
      "SOURCE_READ_FAILED",
    ].includes(code);
    this.retryAfterSeconds = rateRetry;
    this.rateRetry = rateRetry;
  }
}

export type PublicFetchResponse = {
  status: number;
  headers: Headers;
  /** A display-safe URL: query parameters and fragments are never exposed. */
  url: string;
  body: Buffer;
  text: () => Promise<string>;
  json: <T = unknown>() => Promise<T>;
};

type PinnedAddress = { address: string; family: 4 | 6 };

function safeUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function normalizedHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

function isAllowedHost(
  host: string,
  allowedHosts?: readonly string[]
): boolean {
  if (!allowedHosts?.length) return true;
  const candidate = normalizedHost(host);
  return allowedHosts.some(allowed => candidate === normalizedHost(allowed));
}

function isPublicIp(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv4") return parsed.range() === "unicast";
    const ipv6 = parsed as ipaddr.IPv6;
    return !ipv6.isIPv4MappedAddress() && ipv6.range() === "unicast";
  } catch {
    return false;
  }
}

function assertPublicHttpsUrl(
  input: string | URL,
  allowedHosts?: readonly string[]
): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    throw new SourceAccessError("INVALID_URL", "The source URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !url.hostname ||
    !isAllowedHost(url.hostname, allowedHosts)
  ) {
    throw new SourceAccessError(
      "BLOCKED_URL",
      "The source URL is not permitted."
    );
  }
  // Direct IP targets are never necessary for an approved public source and make
  // DNS pinning impossible. Reject them before any socket can be opened.
  if (ipaddr.isValid(url.hostname)) {
    throw new SourceAccessError(
      "BLOCKED_ADDRESS",
      "The source address is not permitted."
    );
  }
  return url;
}

async function lookupPublicHost(
  hostname: string,
  timeoutMs: number
): Promise<PinnedAddress[]> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new SourceAccessError("TIMEOUT", "The source request timed out.")
        ),
      Math.max(1, timeoutMs)
    );
  });
  let records: Array<{ address: string; family: number }>;
  try {
    records = (await Promise.race([
      dnsLookup(hostname, { all: true, verbatim: true }),
      deadline,
    ])) as Array<{ address: string; family: number }>;
  } catch (error) {
    if (error instanceof SourceAccessError) throw error;
    throw new SourceAccessError(
      "DNS_FAILED",
      "The source host could not be resolved."
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!records.length || records.some(record => !isPublicIp(record.address))) {
    throw new SourceAccessError(
      "BLOCKED_ADDRESS",
      "The source address is not permitted."
    );
  }
  return records
    .filter(record => record.family === 4 || record.family === 6)
    .map(record => ({
      address: record.address,
      family: record.family as 4 | 6,
    }));
}

function responseHeaders(
  headers: Record<string, string | string[] | undefined>
): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result.set(name, value);
    else if (Array.isArray(value))
      for (const item of value) result.append(name, item);
  }
  return result;
}

function retryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(Math.ceil(seconds), 86_400);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.min(Math.max(0, Math.ceil((at - Date.now()) / 1000)), 86_400);
}

async function readBounded(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const value = Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) {
      throw new SourceAccessError(
        "RESPONSE_TOO_LARGE",
        "The source response is too large."
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function requestHeaders(source?: HeadersInit): Headers {
  const headers = new Headers(source);
  // Let Undici determine connection framing and the actual content length.
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  return headers;
}

/**
 * Fetch a public HTTPS resource without trusting the runtime resolver at connect
 * time. Each hop is resolved first, all returned addresses are vetted, and a
 * request-local Undici Agent only receives one of those pinned public addresses.
 */
export async function publicFetch(
  input: string | URL,
  options: PublicFetchOptions = {}
): Promise<PublicFetchResponse> {
  const timeoutMs = Math.min(
    Math.max(1, options.timeoutMs ?? MAX_TIMEOUT_MS),
    MAX_TIMEOUT_MS
  );
  const maxBytes = Math.min(
    Math.max(1, options.maxBytes ?? MAX_RESPONSE_BYTES),
    MAX_RESPONSE_BYTES
  );
  const startedAt = Date.now();
  let current = assertPublicHttpsUrl(input, options.allowedHosts);
  let method: FetchMethod =
    options.method ?? (options.jsonBody === undefined ? "GET" : "POST");
  let headers = requestHeaders(options.headers);
  let body: string | undefined;
  if (options.jsonBody !== undefined) {
    if (method !== "POST") {
      throw new SourceAccessError(
        "INVALID_REQUEST",
        "JSON request bodies require POST."
      );
    }
    body = JSON.stringify(options.jsonBody);
    if (!headers.has("content-type"))
      headers.set("content-type", "application/json");
  }

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0)
      throw new SourceAccessError("TIMEOUT", "The source request timed out.");
    current = assertPublicHttpsUrl(current, options.allowedHosts);
    const pins = await lookupPublicHost(current.hostname, remaining);
    const pinned = pins[0];
    if (!pinned)
      throw new SourceAccessError(
        "DNS_FAILED",
        "The source host could not be resolved."
      );

    const agent = new Agent({
      connect: {
        timeout: Math.max(1, remaining),
        lookup: (hostname, _lookupOptions, callback) => {
          // A resolver rebinding attempt cannot substitute a new target: the agent
          // receives only the pre-vetted address set associated with this request.
          if (normalizedHost(hostname) !== normalizedHost(current.hostname)) {
            callback(new Error("Unapproved lookup target"), "", 0);
            return;
          }
          if (_lookupOptions.all) {
            (
              callback as unknown as (
                error: Error | null,
                addresses: PinnedAddress[]
              ) => void
            )(null, pins);
            return;
          }
          callback(null, pinned.address, pinned.family);
        },
      },
      connectTimeout: Math.max(1, remaining),
      headersTimeout: Math.max(1, remaining),
      bodyTimeout: Math.max(1, remaining),
      maxResponseSize: maxBytes,
      pipelining: 0,
    });
    const controller = new AbortController();
    const abortTimer = setTimeout(
      () => controller.abort(),
      Math.max(1, remaining)
    );

    try {
      const result = await request(current, {
        dispatcher: agent,
        method,
        headers,
        body,
        signal: controller.signal,
        headersTimeout: Math.max(1, remaining),
        bodyTimeout: Math.max(1, remaining),
      });
      const resultHeaders = responseHeaders(result.headers);
      const location = resultHeaders.get("location");
      if (REDIRECT_STATUSES.has(result.statusCode) && location) {
        result.body.resume();
        if (redirects === 3) {
          throw new SourceAccessError(
            "REDIRECT_LIMIT",
            "The source redirected too many times."
          );
        }
        const next = assertPublicHttpsUrl(
          new URL(location, current),
          options.allowedHosts
        );
        const crossOrigin = next.origin !== current.origin;
        if (crossOrigin) {
          for (const name of SENSITIVE_HEADERS) headers.delete(name);
        }
        if (method === "POST" && [301, 302, 303].includes(result.statusCode)) {
          method = "GET";
          body = undefined;
          headers.delete("content-type");
        }
        current = next;
        continue;
      }
      if (result.statusCode < 200 || result.statusCode >= 300) {
        result.body.resume();
        const contractsFinderRateLimit =
          result.statusCode === 403 &&
          normalizedHost(current.hostname) === CONTRACTS_FINDER_HOST;
        const code =
          result.statusCode === 429 || contractsFinderRateLimit
            ? "RATE_LIMITED"
            : result.statusCode === 403
              ? "ACCESS_BLOCKED"
              : result.statusCode >= 500
                ? "SOURCE_READ_FAILED"
                : "HTTP_ERROR";
        // Contracts Finder uses 403 when its public endpoint throttles a caller,
        // but other 403s are access denials and must not be retried. Honor a
        // provider Retry-After only for its normal 429/503 semantics.
        const rate = contractsFinderRateLimit
          ? 300
          : result.statusCode === 429 || result.statusCode === 503
            ? retryAfter(resultHeaders)
            : undefined;
        throw new SourceAccessError(
          code,
          "The source request was not accepted.",
          rate
        );
      }
      const contentLength = Number(resultHeaders.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        result.body.resume();
        throw new SourceAccessError(
          "RESPONSE_TOO_LARGE",
          "The source response is too large."
        );
      }
      const responseBody = await readBounded(result.body, maxBytes);
      const finalUrl = safeUrl(current);
      return {
        status: result.statusCode,
        headers: resultHeaders,
        url: finalUrl,
        body: responseBody,
        text: async () => responseBody.toString("utf8"),
        json: async <T = unknown>() => {
          try {
            return JSON.parse(responseBody.toString("utf8")) as T;
          } catch {
            throw new SourceAccessError(
              "INVALID_RESPONSE",
              "The source returned invalid JSON."
            );
          }
        },
      };
    } catch (error) {
      if (error instanceof SourceAccessError) throw error;
      if (controller.signal.aborted) {
        throw new SourceAccessError("TIMEOUT", "The source request timed out.");
      }
      throw new SourceAccessError(
        "NETWORK_ERROR",
        "The source could not be reached."
      );
    } finally {
      clearTimeout(abortTimer);
      await agent.destroy();
    }
  }
  throw new SourceAccessError(
    "REDIRECT_LIMIT",
    "The source redirected too many times."
  );
}
