export const LOCAL_TEST_OWNER_OPEN_ID = "local-test-owner";
export const LOCAL_TEST_PROJECT_ID = "bidforge-local";
export const LOCAL_TEST_SESSION_MS = 8 * 60 * 60 * 1000;

export function isLocalTestMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.LOCAL_TEST_MODE === "true" &&
    typeof env.LOCAL_TEST_PASSWORD === "string" &&
    env.LOCAL_TEST_PASSWORD.length > 0 &&
    env.MANUS_PROJECT_ID === LOCAL_TEST_PROJECT_ID &&
    Buffer.byteLength(env.MANUS_JWT_SECRET ?? "", "utf8") >= 32
  );
}

/**
 * LOCAL_TEST_MODE is deliberately opt-in. A partial configuration must fail at
 * startup rather than accidentally exposing a password login on another app.
 */
export function assertLocalTestConfiguration(
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env.LOCAL_TEST_MODE !== "true") return;

  const missing: string[] = [];
  if (!env.LOCAL_TEST_PASSWORD) missing.push("LOCAL_TEST_PASSWORD");
  if (env.MANUS_PROJECT_ID !== LOCAL_TEST_PROJECT_ID) {
    missing.push(`MANUS_PROJECT_ID=${LOCAL_TEST_PROJECT_ID}`);
  }
  if (Buffer.byteLength(env.MANUS_JWT_SECRET ?? "", "utf8") < 32) {
    missing.push("MANUS_JWT_SECRET (at least 32 bytes)");
  }

  if (missing.length > 0) {
    throw new Error(
      `Invalid LOCAL_TEST_MODE configuration; required: ${missing.join(", ")}`
    );
  }
}
