/**
 * CAD-PARITY-016 (Issue #112) — the bounded large-model streaming surface
 * with explicit cache non-authority (additive, engine-free, Architecture
 * v1.1 FROZEN).
 *
 * Large-model access is paginated (canonical id-sorted element pages, a
 * bounded page-size grammar) and served through a bounded cache keyed by
 * (pageIndex, pageSize) + validated against the CURRENT canonical document
 * version on every request. The cache is NEVER authoritative: every page
 * response carries the canonical documentVersionId/version_number and
 * contentHash it was derived from, and a document edit (a version bump)
 * evicts stale entries with exact accounting (model3d.cacheStats
 * precedent — the performance-budget evidence).
 */

import type { CADDocument } from "../caddocument/document.js";
import type { Element } from "../contracts/caddocument.js";
import type { StreamCacheStatsView, StreamPageView } from "../contracts/collab.js";

/** The bounded page-size grammar. */
export const STREAM_PAGE_SIZE_MIN = 10;
export const STREAM_PAGE_SIZE_MAX = 500;
export const STREAM_PAGE_SIZE_DEFAULT = 100;

/** The bounded cache capacity (entries — LRU eviction beyond this). */
export const STREAM_CACHE_MAX_ENTRIES = 32;

/** Typed streaming failure (surfaces as an app-api typed err). */
export class StreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface CacheEntry {
  readonly versionNumber: number;
  readonly page: StreamPageView;
}

/** Canonical id order (the document's minted ids sort lexically =
 *  numerically — the deterministic canonical element order). */
function canonicalElementOrder(elements: readonly Element[]): readonly Element[] {
  return [...elements].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The bounded large-model stream cache. Every `page` call revalidates the
 * cache entry against the current canonical document version: a version
 * mismatch is a STALE eviction (counted, never served) — the caller always
 * receives page content derived from the CURRENT canonical state.
 */
export class ModelStreamCache {
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private staleEvictions = 0;
  private servedPages = 0;

  stats(): StreamCacheStatsView {
    return {
      entries: this.entries.size,
      maxEntries: STREAM_CACHE_MAX_ENTRIES,
      hits: this.hits,
      misses: this.misses,
      staleEvictions: this.staleEvictions,
      authoritative: false,
      bounded: true,
    };
  }

  get servedPageCount(): number {
    return this.servedPages;
  }

  get hitCount(): number {
    return this.hits;
  }

  get missCount(): number {
    return this.misses;
  }

  get staleEvictionCount(): number {
    return this.staleEvictions;
  }

  /** Serve one canonical page (bounded, deterministic order, version-bound).
   *  `cacheHit` on the response reports whether the page came from the
   *  revalidated cache or was freshly derived — either way the CONTENT is
   *  derived from the current canonical document revision. */
  page(doc: CADDocument, pageIndex: number, pageSize: number): StreamPageView {
    if (!Number.isInteger(pageIndex) || pageIndex < 0) {
      throw new StreamError("stream_invalid", "pageIndex must be a non-negative integer");
    }
    if (
      !Number.isInteger(pageSize) ||
      pageSize < STREAM_PAGE_SIZE_MIN ||
      pageSize > STREAM_PAGE_SIZE_MAX
    ) {
      throw new StreamError(
        "stream_invalid",
        `pageSize must be ${STREAM_PAGE_SIZE_MIN}..${STREAM_PAGE_SIZE_MAX} (canonical grammar)`,
      );
    }
    const snapshot = doc.snapshot();
    const version = snapshot.version;
    const contentHash = doc.currentContentHash();
    const ordered = canonicalElementOrder(doc.allElements());
    const totalElements = ordered.length;
    const totalPages = Math.max(1, Math.ceil(totalElements / pageSize));
    if (pageIndex >= totalPages) {
      throw new StreamError(
        "stream_out_of_range",
        `pageIndex ${pageIndex} is out of range (totalPages ${totalPages}, totalElements ${totalElements})`,
      );
    }
    const key = `${pageIndex}:${pageSize}`;
    const cached = this.entries.get(key);
    if (cached !== undefined && cached.versionNumber === version.version_number) {
      this.hits += 1;
      this.servedPages += 1;
      // The revalidated hit reports `cacheHit: true` on the response (the
      // stored entry carries the derivation-time flag; the CONTENT is
      // identical either way — the cache only ever serves pages derived
      // from the current canonical revision).
      return { ...cached.page, cacheHit: true };
    }
    if (cached !== undefined) {
      this.staleEvictions += 1;
      this.entries.delete(key);
    }
    this.misses += 1;
    const start = pageIndex * pageSize;
    const elements = ordered.slice(start, start + pageSize);
    const page: StreamPageView = {
      pageIndex,
      pageSize,
      totalElements,
      totalPages,
      documentVersionId: version.version_id,
      documentVersionNumber: version.version_number,
      contentHash,
      elements,
      cacheHit: false,
    };
    while (this.entries.size >= STREAM_CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { versionNumber: version.version_number, page });
    this.servedPages += 1;
    return page;
  }

  /** Warm a page without returning it (the background job path). */
  warm(doc: CADDocument, pageIndex: number, pageSize: number): void {
    this.page(doc, pageIndex, pageSize);
  }
}
