/**
 * JSON Schema enforcement tests.
 *
 * Proves the schemas in governance/schemas/ are enforced (not decorative):
 * missing required fields, invalid enums, malformed commit SHAs and bad
 * date-times are all rejected at the schema layer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readJson } from "../src/loaders.js";
import { baseVerifiedRecord, REPO_ROOT } from "./helpers.js";

function compile() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = readJson<object>(join(REPO_ROOT, "governance", "schemas", "work-item.schema.json"));
  return ajv.compile(schema);
}

test("the baseline record conforms to the schema", () => {
  const validate = compile();
  assert.equal(validate(baseVerifiedRecord()), true, JSON.stringify(validate.errors));
});

test("missing required fields are rejected", () => {
  const validate = compile();
  const record = baseVerifiedRecord() as unknown as Record<string, unknown>;
  for (const field of ["id", "architecture_version", "requirements", "acceptance_criteria", "evidence_requirements", "state", "transitions"]) {
    const broken = structuredClone(record);
    delete broken[field];
    assert.equal(validate(broken), false, `record without '${field}' must be rejected`);
  }
});

test("invalid transition roles are rejected", () => {
  const validate = compile();
  const record = baseVerifiedRecord();
  (record.transitions[0] as { role: string }).role = "emperor";
  assert.equal(validate(record), false);
});

test("malformed commit references are rejected", () => {
  const validate = compile();
  const record = baseVerifiedRecord();
  record.evidence![0]!.references = { commit: "not-a-sha" };
  assert.equal(validate(record), false);
});

test("invalid date-times are rejected", () => {
  const validate = compile();
  const record = baseVerifiedRecord();
  record.transitions[0]!.at = "January 1st, 2026";
  assert.equal(validate(record), false);
});

test("unknown evidence types are rejected", () => {
  const validate = compile();
  const record = baseVerifiedRecord();
  record.evidence![0]!.type = "trust-me-bro";
  assert.equal(validate(record), false);
});

test("unknown decision statuses are rejected", () => {
  const validate = compile();
  const record = baseVerifiedRecord();
  record.decisions![0]!.status = "definitely-approved";
  assert.equal(validate(record), false);
});

test("work-item ids must follow the canonical pattern", () => {
  const validate = compile();
  const record = baseVerifiedRecord();
  (record as { id: string }).id = "my work item";
  assert.equal(validate(record), false);
  (record as { id: string }).id = "arch_wf_1";
  assert.equal(validate(record), false);
});
