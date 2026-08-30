/**
 * BIM vertical (story) relationship validators (CAD-PARITY-011, Issue #97).
 *
 * The STRONGER host/story relationships: roofs may declare a reference story
 * they span to; stairs connect two stories (their total rise is DERIVED from
 * the story levels — geometry.ts owns the formula, this module owns the
 * validation). The relationships are enforced at authoring time AND
 * re-enforced whenever a story's level changes — an edit that would break a
 * hosted relationship is a typed rejection (never a silent orphan), which is
 * exactly what "stronger host/story relationships" means operationally.
 *
 * Engine-free semantic validation (LOCK-018). Deterministic: the first
 * failure wins, element order over the map is the caller's deterministic
 * iteration (sorted by id where order matters).
 */

import type { BimEntity, RoofEntity, StairEntity } from "./elements.js";

/** A story lookup over the document entities (the caller's map). */
export type StoryLookup = (id: string) => BimEntity | undefined;

/** Resolve a story id to its level (throws a typed message when missing). */
function storyLevel(lookup: StoryLookup, id: string, context: string): number {
  const story = lookup(id);
  if (story === undefined) {
    throw new Error(`${context}: story '${id}' does not exist`);
  }
  if (story.type !== "bim.story") {
    throw new Error(`${context}: story '${id}' is not a story (got '${story.type}')`);
  }
  return story.level;
}

/**
 * Validate a roof's vertical relationships (host story + the optional
 * reference story the roof spans to):
 *   - the host story must exist (a story element);
 *   - when topStoryId is declared: it must exist, be a story STRICTLY ABOVE
 *     the host story (a roof spans upward), and the ridge must REACH OR
 *     EXCEED the top story's level (host.level + baseOffset + height ≥
 *     top.level) — the roof physically covers the declared vertical range.
 */
export function assertRoofStoryRelationship(roof: RoofEntity, lookup: StoryLookup): void {
  const hostLevel = storyLevel(lookup, roof.storyId, `roof '${roof.id}'`);
  if (roof.topStoryId === undefined) return;
  const topLevel = storyLevel(lookup, roof.topStoryId, `roof '${roof.id}'`);
  if (roof.topStoryId === roof.storyId) {
    throw new Error(`roof '${roof.id}': topStoryId must be a DIFFERENT story above the host story ('${roof.topStoryId}' is the host story itself)`);
  }
  if (topLevel <= hostLevel) {
    throw new Error(
      `roof '${roof.id}': the reference story '${roof.topStoryId}' (level ${topLevel}) must be ABOVE the host story '${roof.storyId}' (level ${hostLevel}) — a roof spans upward`,
    );
  }
  const ridgeZ = hostLevel + roof.baseOffset + roof.height;
  if (ridgeZ < topLevel) {
    throw new Error(
      `roof '${roof.id}': the ridge (level ${ridgeZ}) does not reach the declared reference story '${roof.topStoryId}' (level ${topLevel}) — raise the roof height or span to a lower story`,
    );
  }
}

/**
 * Validate a stair's vertical relationship: both stories exist; the derived
 * total rise (top.level − host.level − baseOffset) is POSITIVE — a stair
 * always climbs from its host story to a strictly higher landing level.
 */
export function assertStairStoryRelationship(stair: StairEntity, lookup: StoryLookup): void {
  const hostLevel = storyLevel(lookup, stair.storyId, `stair '${stair.id}'`);
  const topLevel = storyLevel(lookup, stair.topStoryId, `stair '${stair.id}'`);
  if (stair.topStoryId === stair.storyId) {
    throw new Error(`stair '${stair.id}': topStoryId must be a DIFFERENT story above the host story ('${stair.topStoryId}' is the host story itself)`);
  }
  const rise = topLevel - hostLevel - stair.baseOffset;
  if (rise <= 0) {
    throw new Error(
      `stair '${stair.id}': the derived rise from story '${stair.storyId}' (level ${hostLevel}) to story '${stair.topStoryId}' (level ${topLevel}) minus baseOffset ${stair.baseOffset} is ${rise} — a stair must climb to a higher story level`,
    );
  }
}

/**
 * Re-validate every vertical relationship that involves the story `storyId`
 * after its level changed (move dz / setProperties level/height edits call
 * this BEFORE applying): every roof hosted on or spanning to the story, and
 * every stair starting at or landing on the story, must still satisfy its
 * relationship — otherwise the edit is a typed rejection naming the elements.
 * Deterministic element order (sorted by id).
 */
export function assertStoryEditIntegrity(
  storyId: string,
  entities: Iterable<BimEntity>,
  lookup: StoryLookup,
): void {
  const affected: BimEntity[] = [];
  for (const entity of entities) {
    if (entity.type === "bim.roof" && (entity.storyId === storyId || entity.topStoryId === storyId)) affected.push(entity);
    if (entity.type === "bim.stair" && (entity.storyId === storyId || entity.topStoryId === storyId)) affected.push(entity);
  }
  affected.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const entity of affected) {
    if (entity.type === "bim.roof") assertRoofStoryRelationship(entity, lookup);
    if (entity.type === "bim.stair") assertStairStoryRelationship(entity, lookup);
  }
}

/** The option-group membership meta cross-check (the meta overlay references
 *  a group and one of its declared options). Throws a typed message when the
 *  group does not exist, is not an option group, or the option is not in the
 *  group's declared vocabulary. */
export function assertOptionMembership(
  optionGroupId: string,
  option: string,
  lookup: StoryLookup,
  context: string,
): void {
  const group = lookup(optionGroupId);
  if (group === undefined) {
    throw new Error(`${context}: option group '${optionGroupId}' does not exist (neither in the document nor earlier in this batch)`);
  }
  if (group.type !== "bim.optionGroup") {
    throw new Error(`${context}: optionGroupId '${optionGroupId}' must reference an option group (got '${group.type}')`);
  }
  if (!group.options.includes(option)) {
    throw new Error(
      `${context}: option '${option}' is not declared by option group '${optionGroupId}' (declared options: ${group.options.join(", ")})`,
    );
  }
}

/** Validate the meta overlay references of one entity against the document
 *  (option-group membership — the structural overlay validation already ran
 *  in the strict constructors; this is the cross-ELEMENT part). */
export function assertEntityMetaReferences(entity: BimEntity, lookup: StoryLookup, context: string): void {
  const meta = (entity as { meta?: { optionGroupId?: string; option?: string } }).meta;
  if (meta?.optionGroupId !== undefined && meta.option !== undefined) {
    assertOptionMembership(meta.optionGroupId, meta.option, lookup, context);
  }
}
