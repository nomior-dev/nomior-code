/**
 * Nomior Code branding constants.
 *
 * The single source of truth for user-visible product naming in the fork.
 * Display strings only: npm package names, binary names, config dirs
 * (`t3code`, `~/.t3`), protocol schemes, and app IDs deliberately keep their
 * upstream values so upstream merges and existing user state stay intact.
 * See docs/nomior/FORK-MANIFEST.md for the files wired to this module.
 */
export const NOMIOR_PRODUCT_NAME = "Nomior Code";

/**
 * True when a user-visible display string still carries upstream's "T3"
 * branding. Guards rebranded surfaces in tests without hardcoding the
 * upstream mark at every call site.
 */
export function containsUpstreamBranding(display: string): boolean {
  return /\bT3\b/i.test(display);
}
