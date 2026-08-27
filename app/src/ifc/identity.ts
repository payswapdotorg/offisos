/**
 * IFC identity derivation (COMPAT-IFC-001 / Issue #47).
 *
 * Canonical element ids are the identity (LOCK-019; RESEARCH-CAD-003
 * finding: engine GlobalIds are disjoint across regeneration while
 * canonical domain ids are stable). IFC files, however, address elements
 * by IfcGuid — so Offisos derives each element's IfcGuid DETERMINISTICALLY
 * from its canonical id: sha256(salt + canonicalId) → 128 bits → the
 * 22-char base64 IfcGuid alphabet. The same canonical id therefore always
 * produces the same IfcGuid on every host and every export, and BCF/IDS
 * references (which speak IfcGuid) resolve back through the identity psets
 * — never by guessing.
 *
 * The IfcGuid encoding (buildingSMART): the 128-bit value is encoded in
 * base64 with the IFC alphabet `0-9A-Za-z_$`; the first character carries
 * only 2 bits (values 0-3) because the encoding starts 12 padding bits in
 * (mirrors ifcopenshell.guid.compress exactly — see the round-trip tests).
 */

import { createHash } from "node:crypto";

export const IFC_GUID_SALT = "offisos-ifc-guid:v1";

const STD_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const IFC_B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

const STD_TO_IFC: Readonly<Record<string, string>> = Object.fromEntries(
  STD_B64.split("").map((c, i) => [c, IFC_B64[i]!]),
);

/** Derive the deterministic IfcGuid (22 chars) for a canonical element id. */
export function ifcGuidFor(canonicalId: string): string {
  const digest = createHash("sha256").update(`${IFC_GUID_SALT}:${canonicalId}`).digest();
  // 18 bytes = 2 zero padding bytes + the 16 digest bytes; base64 → 24 chars;
  // the first 2 chars encode the padding (always "AA") and are dropped,
  // leaving the 22-char IfcGuid (exactly ifcopenshell.guid.compress).
  const padded = Buffer.alloc(18);
  digest.copy(padded, 2);
  const std = padded.toString("base64");
  let out = "";
  for (let i = 2; i < 24; i++) {
    out += STD_TO_IFC[std[i]!] ?? "";
  }
  return out;
}

/** Structural validation of an IfcGuid (22 chars, IFC alphabet, first char
 *  restricted to 0-3 by the encoding's leading 2 bits). */
export function isIfcGuid(value: string): boolean {
  if (typeof value !== "string" || value.length !== 22) return false;
  for (let i = 0; i < value.length; i++) {
    if (!IFC_B64.includes(value[i]!)) return false;
  }
  return "0123".includes(value[0]!);
}
