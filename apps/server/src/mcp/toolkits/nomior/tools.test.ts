import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { NomiorContextToolkit } from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

it("exposes exactly the four context tools", () => {
  expect(Object.keys(NomiorContextToolkit.tools).sort()).toEqual([
    "context_decisions",
    "context_get",
    "context_remember",
    "context_search",
  ]);
});

it("exports provider-compatible object schemas with described, token-cheap definitions", () => {
  for (const tool of Object.values(NomiorContextToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly required?: ReadonlyArray<string>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    // Tool schemas ride in every agent turn; keep them cheap.
    expect(
      tool.description?.length ?? 0,
      `${tool.name} description must stay token-cheap`,
    ).toBeLessThanOrEqual(300);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass`,
      ).toBe(true);
    }
  }
});

it("keeps context_search hot-path friendly: only query is required", () => {
  const schema = Tool.getJsonSchema(NomiorContextToolkit.tools.context_search) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
    "budget_tokens",
    "query",
    "response_format",
    "scope",
  ]);
  expect(schema.required).toEqual(["query"]);
});

it("shapes the remaining tools", () => {
  const requiredOf = (name: keyof typeof NomiorContextToolkit.tools) => {
    const schema = Tool.getJsonSchema(NomiorContextToolkit.tools[name]) as {
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly required?: ReadonlyArray<string>;
    };
    return {
      properties: Object.keys(schema.properties ?? {}).sort(),
      required: [...(schema.required ?? [])].sort(),
    };
  };
  expect(requiredOf("context_get")).toEqual({ properties: ["expand", "id"], required: ["id"] });
  expect(requiredOf("context_decisions")).toEqual({
    properties: ["project", "since"],
    required: ["project"],
  });
  expect(requiredOf("context_remember")).toEqual({
    properties: ["scope", "text"],
    required: ["scope", "text"],
  });
});

it("marks reads as read-only, closed-world tools and remember as a non-destructive write", () => {
  const { context_search, context_get, context_decisions, context_remember } =
    NomiorContextToolkit.tools;
  for (const tool of [context_search, context_get, context_decisions]) {
    expect(Context.get(tool.annotations, Tool.Readonly), `${tool.name} readonly`).toBe(true);
    expect(Context.get(tool.annotations, Tool.Destructive), `${tool.name} destructive`).toBe(false);
    expect(Context.get(tool.annotations, Tool.Idempotent), `${tool.name} idempotent`).toBe(true);
    expect(Context.get(tool.annotations, Tool.OpenWorld), `${tool.name} openWorld`).toBe(false);
  }
  expect(Context.get(context_remember.annotations, Tool.Readonly)).toBe(false);
  expect(Context.get(context_remember.annotations, Tool.Destructive)).toBe(false);
  expect(Context.get(context_remember.annotations, Tool.OpenWorld)).toBe(false);
});
