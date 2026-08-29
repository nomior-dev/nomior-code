/**
 * The Google OAuth client id this build ships with, if any.
 *
 * Asking every user to create a Google Cloud project and paste a client id is
 * developer-grade setup for what should be one button, so a released build
 * carries its own. A native app's client id is a public identifier rather than
 * a secret — the flow is PKCE against a loopback redirect and there is no
 * client secret to leak — which is exactly the case Google's installed-app
 * clients exist for.
 *
 * Set at build time via `NOMIOR_GOOGLE_CLIENT_ID`. Unset (a source checkout, a
 * fork, an unreleased build) leaves it null and the operator supplies their own
 * under Settings → Connectors → Advanced.
 *
 * Why a fork still needs the override: the bundled id belongs to one Google
 * Cloud project whose verification status and quota every install shares. A
 * fork that would rather not share either — or a Workspace org that blocks
 * apps it did not approve — points at its own project instead.
 *
 * @module nomior/connectors/google/bundledClientId
 */

/**
 * A Google installed-app client id, e.g.
 * `000000000000-xxxxxxxx.apps.googleusercontent.com`. Anything that is not
 * shaped like one is treated as unset rather than sent to Google, so a
 * mis-set build variable fails as "no bundled id" instead of as a confusing
 * `invalid_client` on the consent screen.
 */
const CLIENT_ID_PATTERN = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/u;

const raw = process.env["NOMIOR_GOOGLE_CLIENT_ID"]?.trim() ?? "";

export const bundledGoogleClientId: string | null =
  raw.length > 0 && CLIENT_ID_PATTERN.test(raw) ? raw : null;
