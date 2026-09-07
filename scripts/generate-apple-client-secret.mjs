// One-off, manually-run script — NOT wired into app boot. Sign in with
// Apple's OAuth client secret must be a JWT signed with your Apple
// "Sign in with Apple" private key (ES256) — Apple does not accept a
// plain static secret string the way Google does. This mints that JWT.
//
//   node --env-file=.env.local scripts/generate-apple-client-secret.mjs
//
// Requires APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_CLIENT_ID (the Services ID,
// e.g. com.bostonbijold.chrps.signin), and APPLE_PRIVATE_KEY (base64 of
// the downloaded .p8 file's raw contents — same base64 convention as
// APNS_PRIVATE_KEY in lib/apns.ts, chosen there after a pasted PEM came
// out corrupted via Vercel's dashboard; same risk applies here) already
// set in the environment.
//
// Prints the resulting JWT — paste it into Vercel as APPLE_CLIENT_SECRET.
// Apple caps this token's lifetime at 6 months (15777000s); this mints one
// good for 180 days, so re-run and re-paste before it expires or Apple
// sign-in will start failing with an invalid_client error.

import { SignJWT, importPKCS8 } from "jose";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} env var. Run with: node --env-file=.env.local scripts/generate-apple-client-secret.mjs`);
    process.exit(1);
  }
  return value;
}

const teamId = requireEnv("APPLE_TEAM_ID");
const keyId = requireEnv("APPLE_KEY_ID");
const clientId = requireEnv("APPLE_CLIENT_ID");
const privateKeyPem = Buffer.from(requireEnv("APPLE_PRIVATE_KEY"), "base64").toString("utf8");

const SIX_MONTHS_MINUS_BUFFER_SECONDS = 180 * 24 * 60 * 60;

const key = await importPKCS8(privateKeyPem, "ES256");
const jwt = await new SignJWT({})
  .setProtectedHeader({ alg: "ES256", kid: keyId })
  .setIssuedAt()
  .setIssuer(teamId)
  .setAudience("https://appleid.apple.com")
  .setSubject(clientId)
  .setExpirationTime(Math.floor(Date.now() / 1000) + SIX_MONTHS_MINUS_BUFFER_SECONDS)
  .sign(key);

console.log(jwt);
