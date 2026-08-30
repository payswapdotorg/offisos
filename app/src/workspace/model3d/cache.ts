/**
 * CAD-PARITY-010 (Issue #93): the bounded tessellation/mesh cache core.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018). Large-model
 * performance infrastructure (Issue #93 §5):
 *
 *  - BOUNDED: the cache enforces BOTH an entry-count capacity and a total
 *    cached-VERTEX budget; eviction is least-recently-used (deterministic
 *    given a deterministic request order — the counters are exact evidence).
 *  - REVISION-TIED KEYS: entries are keyed by the CANONICAL encoding of the
 *    element's geometry descriptor + the quality preset. The descriptor is
 *    the element's canonical geometry declaration — when a modeling edit
 *    (transform/boolean) produces a new document revision for the element,
 *    the descriptor changes, the key changes and the stale entry becomes
 *    unreachable (invalidation tied to canonical model revisions — the
 *    acceptance criterion); unrelated document edits never flush geometry
 *    that did not change.
 *  - MEASURABLE: hits/misses/evictions/entries/cachedVertices counters are
 *    exposed for the performance-budget evidence (deterministic counters,
 *    not wall-clock — the regression evidence is reproducible).
 *
 * This module stays crypto-free and serialization-free for the browser
 * bundle (the section.ts precedent): the descriptor key is a canonical
 * structural encoding, not a hash.
 */

import type { GeometryDescriptor, MeshData, MeshQualityPreset } from "../../contracts/geometry.js";

/** The default bounded capacities (documented budgets). */
export const DEFAULT_CACHE_CAPACITY = 128;
export const DEFAULT_CACHE_VERTEX_BUDGET = 1_500_000;

/** One cached tessellation result. */
export interface TessellationCacheEntry {
  readonly mesh: MeshData;
  readonly meshToken: string;
  readonly vertices: number;
  readonly triangles: number;
}

/** The deterministic cache statistics (exact counters — reproducible
 *  performance evidence). */
export interface TessellationCacheStats {
  readonly capacity: number;
  readonly vertexBudget: number;
  readonly entries: number;
  readonly cachedVertices: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
}

/** Canonical structural encoding of a geometry descriptor — the cache key
 *  basis (deterministic + injective for the descriptor vocabulary: shapes
 *  are tagged unions, so sorted-key canonical encoding is unambiguous). */
export function descriptorCacheKey(descriptor: GeometryDescriptor): string {
  return encodeCanonical(descriptor);
}

function encodeCanonical(value: unknown): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? `#${value}` : `#!${String(value)}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "#true" : "#false";
  if (value === null) return "#null";
  if (Array.isArray(value)) return `[${value.map(encodeCanonical).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${encodeCanonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return "#undefined";
}

/** The bounded LRU tessellation cache with vertex budget + exact counters. */
export class TessellationCache {
  private readonly capacity: number;
  private readonly vertexBudget: number;
  private readonly entries = new Map<string, TessellationCacheEntry>();
  private cachedVertices = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(capacity: number = DEFAULT_CACHE_CAPACITY, vertexBudget: number = DEFAULT_CACHE_VERTEX_BUDGET) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`TessellationCache capacity must be a positive integer (got ${capacity})`);
    }
    if (!Number.isInteger(vertexBudget) || vertexBudget <= 0) {
      throw new Error(`TessellationCache vertexBudget must be a positive integer (got ${vertexBudget})`);
    }
    this.capacity = capacity;
    this.vertexBudget = vertexBudget;
  }

  /** The full cache key: canonical descriptor encoding + quality preset. */
  static key(descriptor: GeometryDescriptor, quality: MeshQualityPreset): string {
    return `${quality}:${descriptorCacheKey(descriptor)}`;
  }

  /** Look up (LRU touch on hit; counters exact). */
  get(key: string): TessellationCacheEntry | null {
    const entry = this.entries.get(key) ?? null;
    if (entry === null) {
      this.misses += 1;
      return null;
    }
    // LRU touch: re-insert at the end (Map preserves insertion order).
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry;
  }

  /** Insert (bounded: evicts LRU entries until BOTH budgets hold; refuses
   *  entries larger than the whole vertex budget without evicting
   *  everything — a single oversized entry is declined and counted as an
   *  eviction attempt, never silently unbounded). */
  set(key: string, entry: TessellationCacheEntry): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.cachedVertices -= existing.mesh.vertices.length / 3;
      this.entries.delete(key);
    }
    const vertexCount = entry.mesh.vertices.length / 3;
    if (vertexCount > this.vertexBudget) {
      // An entry that cannot fit the budget at all: do not evict the world
      // for it (record the refusal deterministically).
      this.evictions += 1;
      return;
    }
    this.entries.set(key, entry);
    this.cachedVertices += vertexCount;
    while (
      this.entries.size > this.capacity ||
      (this.cachedVertices > this.vertexBudget && this.entries.size > 1)
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const removed = this.entries.get(oldest)!;
      this.cachedVertices -= removed.mesh.vertices.length / 3;
      this.entries.delete(oldest);
      this.evictions += 1;
    }
  }

  /** Explicit invalidation (the App API may drop a specific key — e.g. when
   *  an element's geometry is updated, its stale keys are dropped eagerly). */
  invalidate(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    this.cachedVertices -= entry.mesh.vertices.length / 3;
    this.entries.delete(key);
    return true;
  }

  /** Drop every entry whose key starts with the given prefix (e.g. all
   *  quality presets of one descriptor). Returns the number dropped. */
  invalidatePrefix(prefix: string): number {
    const keys: string[] = [];
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) this.invalidate(key);
    return keys.length;
  }

  /** The exact counters (deterministic evidence). */
  stats(): TessellationCacheStats {
    return {
      capacity: this.capacity,
      vertexBudget: this.vertexBudget,
      entries: this.entries.size,
      cachedVertices: this.cachedVertices,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}
