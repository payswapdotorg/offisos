/**
 * App API wire-contract schema validation (api-contract.md §1, §7, §8).
 *
 * Asserts the JSON Schemas are valid AJV schemas and that representative
 * payloads validate (positive + negative). Additive changes preserve
 * backward compatibility; breaking changes create a new version (§8).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import {
  APP_API_VERSIONS,
  COMMAND_PAYLOAD_SCHEMAS,
  QUERY_PAYLOAD_SCHEMAS,
  WIRE_ENVELOPE_SCHEMA,
} from "../src/app-api/index.js";

const ajv = new Ajv({ allErrors: true, strict: false });

test("APP_API_VERSIONS declares v1", () => {
  assert.ok(APP_API_VERSIONS.includes("1"));
});

test("wire envelope schema validates a well-formed envelope", () => {
  const validate = ajv.compile(WIRE_ENVELOPE_SCHEMA);
  const ok = validate({
    api: "1",
    body: { type: "command", name: "document.applyEdit", payload: { edit: { type: "addElement" } } },
  });
  assert.equal(ok, true, JSON.stringify(validate.errors));
});

test("wire envelope schema rejects an unknown api version", () => {
  const validate = ajv.compile(WIRE_ENVELOPE_SCHEMA);
  const ok = validate({ api: "2", body: { type: "query", name: "document.getState" } });
  assert.equal(ok, false);
});

test("every command payload schema is a valid AJV schema", () => {
  for (const [name, schema] of Object.entries(COMMAND_PAYLOAD_SCHEMAS)) {
    const validate = ajv.compile(schema);
    assert.equal(typeof validate, "function", `schema for ${name} did not compile`);
  }
});

test("every query payload schema is a valid AJV schema", () => {
  for (const [name, schema] of Object.entries(QUERY_PAYLOAD_SCHEMAS)) {
    const validate = ajv.compile(schema);
    assert.equal(typeof validate, "function", `schema for ${name} did not compile`);
  }
});

test("document.applyEdit schema accepts a well-formed edit and rejects a missing edit", () => {
  const validate = ajv.compile(COMMAND_PAYLOAD_SCHEMAS["document.applyEdit"]);
  assert.ok(validate({ edit: { type: "addElement", element: { id: "e1" } } }));
  assert.equal(validate({}), false);
  assert.equal(validate({ edit: { type: "notARealType" } }), false);
});

test("document.deserialize schema requires text", () => {
  const validate = ajv.compile(COMMAND_PAYLOAD_SCHEMAS["document.deserialize"]);
  assert.ok(validate({ text: "{}" }));
  assert.equal(validate({}), false);
});
