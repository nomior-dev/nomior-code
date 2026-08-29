import { assert, describe, it } from "@effect/vitest";

import type { NomiorSourceKind } from "./Model.ts";
import type { ContextScope } from "./RetrievalPort.ts";
import {
  formatContextScope,
  parseContextScope,
  reconstructSourceText,
  toPortSourceKind,
} from "./RetrievalPortLive.ts";

describe("parseContextScope", () => {
  it("splits a `kind:value` scope the toolkit passes", () => {
    assert.deepStrictEqual(parseContextScope("project:nomior" as ContextScope), {
      kind: "project",
      value: "nomior",
    });
    assert.deepStrictEqual(parseContextScope("customer:acme" as ContextScope), {
      kind: "customer",
      value: "acme",
    });
  });

  it("reads an unprefixed scope as a project, so a bare project id still works", () => {
    assert.deepStrictEqual(parseContextScope("nomior" as ContextScope), {
      kind: "project",
      value: "nomior",
    });
  });

  it("treats an unknown prefix as part of the project id, never as a new scope kind", () => {
    assert.deepStrictEqual(parseContextScope("team:platform" as ContextScope), {
      kind: "project",
      value: "team:platform",
    });
  });

  it("round-trips with formatContextScope", () => {
    const scope = { kind: "capsule", value: "q3-planning" } as const;
    assert.deepStrictEqual(parseContextScope(formatContextScope(scope)), scope);
  });
});

describe("toPortSourceKind", () => {
  it("maps engine kinds onto the toolkit's catalog", () => {
    const cases: ReadonlyArray<[NomiorSourceKind, string]> = [
      ["meeting", "meeting"],
      ["document", "document"],
      ["memory", "memory"],
      ["decision", "decision"],
      ["email", "mail"],
      ["session", "document"],
    ];
    for (const [engine, port] of cases) {
      assert.strictEqual(toPortSourceKind(engine), port);
    }
  });
});

describe("reconstructSourceText", () => {
  it("places each chunk at its own offset so evidence spans stay valid", () => {
    const chunks = [
      { charStart: 0, text: "Ivan: First." },
      { charStart: 14, text: "Olga: Second." },
    ];
    const text = reconstructSourceText(chunks);
    assert.strictEqual(text, "Ivan: First.\n\nOlga: Second.");
    for (const chunk of chunks) {
      assert.strictEqual(
        text.slice(chunk.charStart, chunk.charStart + chunk.text.length),
        chunk.text,
      );
    }
  });

  it("is empty for a source with no chunks", () => {
    assert.strictEqual(reconstructSourceText([]), "");
  });

  it("does not shift a chunk that starts exactly where the previous one ended", () => {
    assert.strictEqual(
      reconstructSourceText([
        { charStart: 0, text: "abc" },
        { charStart: 3, text: "def" },
      ]),
      "abcdef",
    );
  });
});
