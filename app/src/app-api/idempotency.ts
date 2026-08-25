/**
 * Idempotency cache for mutating commands (api-contract.md §4).
 *
 * Two commands with the same idempotency key are applied at most once; the
 * cached response is returned for subsequent occurrences. The cache is
 * bounded to prevent unbounded growth.
 */

import type { CommandQueryResponse } from "../contracts/app-api.js";

const MAX_ENTRIES = 1024;

export class IdempotencyCache {
  private readonly store = new Map<string, CommandQueryResponse>();

  get(key: string): CommandQueryResponse | undefined {
    const value = this.store.get(key);
    if (value !== undefined) {
      // Refresh recency (LRU-ish).
      this.store.delete(key);
      this.store.set(key, value);
    }
    return value;
  }

  set(key: string, response: CommandQueryResponse): void {
    if (this.store.size >= MAX_ENTRIES) {
      const oldest = this.store.keys().next();
      if (oldest.done !== true) {
        this.store.delete(oldest.value as string);
      }
    }
    this.store.set(key, response);
  }

  size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}
