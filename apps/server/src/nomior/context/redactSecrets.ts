/**
 * redactSecrets - defense-in-depth scrub applied to every piece of text the
 * Nomior context tools return over MCP, and to `context_remember` text before
 * it is stored. The context engine must never index secrets in the first
 * place; this pass guarantees that even if one slips into a source (e.g.
 * pasted into a meeting note), it does not reach an agent or the candidate
 * store.
 *
 * @module nomior/context/redactSecrets
 */

interface SecretPattern {
  readonly kind: string;
  readonly pattern: RegExp;
}

// Order matters: structured, high-confidence formats first so a specific kind
// label wins over the generic assignment catch-all.
const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  {
    kind: "private-key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  { kind: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g },
  { kind: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/g },
  { kind: "openai-style-key", pattern: /\bsk-[A-Za-z0-9_-]{20,255}\b/g },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: "bearer-header", pattern: /\bauthorization\s*:\s*bearer\s+[^\s'"]+/gi },
  {
    kind: "assigned-credential",
    pattern:
      /\b(?<label>(?:api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|auth[_-]?token|refresh[_-]?token|password|passwd)s?)\s*(?:[=:]|:=)\s*["']?[^\s"']{8,}["']?/gi,
  },
];

/**
 * Replaces every recognized secret with `[redacted:<kind>]`. Idempotent and
 * safe on arbitrary prose; unmatched text passes through untouched.
 */
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const { kind, pattern } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, ...rest) => {
      const groups = rest.at(-1);
      const label =
        typeof groups === "object" && groups !== null && "label" in groups
          ? (groups as { readonly label?: string }).label
          : undefined;
      return label === undefined ? `[redacted:${kind}]` : `${label}=[redacted:${kind}]`;
    });
  }
  return redacted;
}
