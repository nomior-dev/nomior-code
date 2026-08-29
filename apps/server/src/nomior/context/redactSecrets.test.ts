import { describe, expect, it } from "vite-plus/test";

import { redactSecrets } from "./redactSecrets.ts";

describe("redactSecrets", () => {
  it("passes ordinary prose through untouched", () => {
    const prose =
      "We agreed the retrieval stack uses FTS5 BM25 plus sqlite-vec, budget capped at 2k tokens.";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("redacts high-confidence token formats", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["AKIAIOSFODNN7EXAMPLE", "aws-access-key-id"],
      ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github-token"],
      ["xoxb-123456789012-abcdefghijklmnop", "slack-token"],
      ["sk-abcdefghijklmnopqrstuvwxyz123456", "openai-style-key"],
      ["AIzaSyA1234567890abcdefghijklmnopqrstuv", "google-api-key"],
      [
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        "jwt",
      ],
    ];
    for (const [secret, kind] of cases) {
      const redacted = redactSecrets(`the value is ${secret} ok`);
      expect(redacted, `${kind} should be redacted`).not.toContain(secret);
      expect(redacted).toContain(`[redacted:${kind}]`);
    }
  });

  it("redacts private key blocks entirely", () => {
    const block =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7bq\nmore\n-----END RSA PRIVATE KEY-----";
    const redacted = redactSecrets(`prefix\n${block}\nsuffix`);
    expect(redacted).not.toContain("MIIEowIBAAKCAQEA7bq");
    expect(redacted).toContain("[redacted:private-key]");
    expect(redacted).toContain("prefix");
    expect(redacted).toContain("suffix");
  });

  it("redacts assigned credentials while keeping the label", () => {
    const redacted = redactSecrets("set API_KEY=super-secret-value-1234 in the env");
    expect(redacted).not.toContain("super-secret-value-1234");
    expect(redacted).toContain("API_KEY=[redacted:assigned-credential]");
  });

  it("redacts bearer authorization headers", () => {
    const redacted = redactSecrets("curl -H 'Authorization: Bearer abc.def.ghi-jkl'");
    expect(redacted).not.toContain("abc.def.ghi-jkl");
    expect(redacted).toContain("[redacted:bearer-header]");
  });

  it("is idempotent", () => {
    const once = redactSecrets("token AKIAIOSFODNN7EXAMPLE end");
    expect(redactSecrets(once)).toBe(once);
  });
});
