import assert from "node:assert/strict";
import { test } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createManagedTools } from "../packages/bittune-runtime/src/harness/managed-tools.ts";
import { wrapToolDefinition } from "../packages/bittune-runtime/src/core/tools/tool-definition-wrapper.ts";
import { exposePlanActions } from "../packages/bittune-runtime/src/workbench/plan-schema.ts";

test("Web exposes all plan actions while preserving native action validation and execution", () => {
  const original = wrapToolDefinition(
    createManagedTools({ client: () => undefined }).find(
      (t) => t.name === "plan_deployment",
    )!,
  );
  const projected = exposePlanActions(original);
  const json = JSON.parse(JSON.stringify(projected.parameters));
  assert.equal(json.type, "object");
  assert.equal(json.anyOf, undefined);
  assert.deepEqual(json.properties.action.enum, [
    "create",
    "validate",
    "freeze",
  ]);
  assert.equal(projected.execute, original.execute);
  assert.ok((original.parameters as any).anyOf, "CLI schema stays unchanged");
  for (const args of [
    {
      action: "create",
      prior_source: "user_specified",
      based_on_plan_id: "plan-base",
      serving_spec: { max_num_seqs: 4 },
    },
    { action: "validate", plan_id: "plan-base" },
  ]) {
    const prepared = projected.prepareArguments!(args);
    assert.deepEqual(
      validateToolArguments(projected, {
        type: "toolCall",
        id: "fixture",
        name: projected.name,
        arguments: prepared as any,
      }),
      args,
    );
  }
  assert.throws(() => projected.prepareArguments!({ action: "create" }));
  assert.throws(() =>
    projected.prepareArguments!({
      action: "validate",
      plan_id: "plan-base",
      prior_source: "none",
    }),
  );
});
