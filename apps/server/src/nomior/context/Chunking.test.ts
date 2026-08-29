import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { computeContextualPrefix, planChunks, renderSegment } from "./Chunking.ts";
import { SourceSegment } from "./Model.ts";

const decodeSegment = Schema.decodeSync(SourceSegment);

const segment = (
  text: string,
  speaker?: string,
  rest?: { readonly section?: string; readonly tsStart?: number; readonly tsEnd?: number },
): SourceSegment => decodeSegment({ text, ...(speaker === undefined ? {} : { speaker }), ...rest });

describe("planChunks", () => {
  it("keeps every chunk an exact slice of the canonical text", () => {
    const plan = planChunks(
      [
        segment("We agreed to ship in September.", "Ivan"),
        segment("I will prepare the migration plan.", "Olga"),
        segment("Deadline noted."),
      ],
      1200,
    );
    assert.isAbove(plan.chunks.length, 0);
    for (const chunk of plan.chunks) {
      assert.strictEqual(plan.canonicalText.slice(chunk.charStart, chunk.charEnd), chunk.text);
    }
  });

  it("never splits a speaker turn across chunks", () => {
    const turnA = `Ivan: ${"alpha ".repeat(80).trim()}`;
    const turnB = `Olga: ${"beta ".repeat(80).trim()}`;
    const plan = planChunks(
      [segment("alpha ".repeat(80).trim(), "Ivan"), segment("beta ".repeat(80).trim(), "Olga")],
      600,
    );
    // Each turn is under maxChars but together they exceed it: two chunks,
    // each holding one whole turn.
    assert.strictEqual(plan.chunks.length, 2);
    assert.strictEqual(plan.chunks[0]!.text, turnA);
    assert.strictEqual(plan.chunks[1]!.text, turnB);
    assert.strictEqual(plan.chunks[0]!.speaker, "Ivan");
    assert.strictEqual(plan.chunks[1]!.speaker, "Olga");
  });

  it("ends a chunk on a speaker change even when there is room left", () => {
    // Two turns that would fit together. Merging them would leave the chunk
    // with no single speaker for its contextual prefix, and the transcript UI
    // with no turn boundary to render.
    const plan = planChunks([segment("Short one.", "Ivan"), segment("Short two.", "Olga")], 1200);
    assert.strictEqual(plan.chunks.length, 2);
    assert.strictEqual(plan.chunks[0]!.speaker, "Ivan");
    assert.strictEqual(plan.chunks[0]!.text, "Ivan: Short one.");
    assert.strictEqual(plan.chunks[1]!.speaker, "Olga");
    assert.strictEqual(plan.chunks[1]!.text, "Olga: Short two.");
  });

  it("still packs consecutive segments from one speaker", () => {
    const plan = planChunks([segment("Short one.", "Ivan"), segment("Short two.", "Ivan")], 1200);
    assert.strictEqual(plan.chunks.length, 1);
    assert.strictEqual(plan.chunks[0]!.speaker, "Ivan");
    assert.strictEqual(plan.chunks[0]!.text, "Ivan: Short one.\n\nIvan: Short two.");
  });

  it("packs speakerless segments together, so documents chunk unchanged", () => {
    const plan = planChunks([segment("First para."), segment("Second para.")], 1200);
    assert.strictEqual(plan.chunks.length, 1);
    assert.strictEqual(plan.chunks[0]!.speaker, null);
  });

  it("splits an oversized single turn at sentence boundaries, keeping the speaker", () => {
    const sentences = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} ends here.`);
    const plan = planChunks([segment(sentences.join(" "), "Ivan")], 200);
    assert.isAbove(plan.chunks.length, 1);
    for (const chunk of plan.chunks) {
      assert.isAtMost(chunk.text.length, 200);
      assert.strictEqual(chunk.speaker, "Ivan");
      assert.strictEqual(plan.canonicalText.slice(chunk.charStart, chunk.charEnd), chunk.text);
    }
    // No sentence is cut in half: each piece ends at a sentence boundary.
    for (const chunk of plan.chunks) {
      assert.match(chunk.text, /\.$/u);
    }
  });

  it("hard-splits pathological unbroken text instead of overflowing", () => {
    const plan = planChunks([segment("x".repeat(1000))], 300);
    assert.isAbove(plan.chunks.length, 1);
    for (const chunk of plan.chunks) {
      assert.isAtMost(chunk.text.length, 300);
    }
  });

  it("assigns sequential ordinals and carries timestamps", () => {
    const plan = planChunks(
      [
        segment("first turn text", "A", { tsStart: 0, tsEnd: 10 }),
        segment("second turn text", "B", { tsStart: 10, tsEnd: 25 }),
      ],
      10,
    );
    assert.deepStrictEqual(
      plan.chunks.map((chunk) => chunk.ordinal),
      plan.chunks.map((_, index) => index),
    );
    assert.strictEqual(plan.chunks[0]!.tsStart, 0);
  });

  it("takes the chunk end time from the last timestamped piece", () => {
    // The trailing untimed segment must not drag tsEnd back to tsStart. One
    // speaker throughout, since a change would split the chunk before the
    // timestamps could interact.
    const untimedTail = planChunks(
      [segment("first turn", "A", { tsStart: 300, tsEnd: 320 }), segment("untimed aside", "A")],
      1200,
    );
    assert.strictEqual(untimedTail.chunks.length, 1);
    assert.strictEqual(untimedTail.chunks[0]!.tsStart, 300);
    assert.strictEqual(untimedTail.chunks[0]!.tsEnd, 320);

    // A last piece with only tsStart contributes that, not the chunk's start.
    const startOnlyTail = planChunks(
      [
        segment("first turn", "A", { tsStart: 300, tsEnd: 320 }),
        segment("later turn", "A", { tsStart: 400 }),
      ],
      1200,
    );
    assert.strictEqual(startOnlyTail.chunks.length, 1);
    assert.strictEqual(startOnlyTail.chunks[0]!.tsEnd, 400);

    // No piece timed at all: no invented end time.
    const untimed = planChunks([segment("a"), segment("b")], 1200);
    assert.strictEqual(untimed.chunks[0]!.tsEnd, null);
  });

  it("handles Cyrillic text identically", () => {
    const plan = planChunks([segment("Мы решили перенести запуск на сентябрь.", "Иван")], 1200);
    assert.strictEqual(plan.chunks.length, 1);
    assert.strictEqual(plan.chunks[0]!.text, "Иван: Мы решили перенести запуск на сентябрь.");
  });
});

describe("computeContextualPrefix", () => {
  it("is deterministic: title, kind, date, time range, speaker", () => {
    const prefix = computeContextualPrefix(
      { kind: "meeting", title: "Launch sync", occurredAt: "2026-08-12T10:00:00.000Z" },
      { speaker: "Ivan", tsStart: 65, tsEnd: 130, section: null },
    );
    assert.strictEqual(prefix, "Launch sync · meeting · 2026-08-12 · 01:05–02:10 · Ivan");
  });

  it("prefers section over timestamps and omits missing parts", () => {
    const prefix = computeContextualPrefix(
      { kind: "document", title: "Runbook" },
      { speaker: null, tsStart: null, tsEnd: null, section: "Rollback" },
    );
    assert.strictEqual(prefix, "Runbook · document · Rollback");
  });
});

describe("renderSegment", () => {
  it("prefixes the speaker when present", () => {
    assert.strictEqual(renderSegment(segment("hi")), "hi");
    assert.strictEqual(renderSegment(segment("hi", "Ivan")), "Ivan: hi");
  });
});
