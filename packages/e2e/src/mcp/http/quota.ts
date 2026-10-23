/**
 * The HTTP gateway's per-domain session quota. A session counts from the
 * moment it opens a target until it closes it; sessions of one principal on
 * one domain share the limit. A target opened past the limit reclaims the
 * bucket's least recently active session, so a client that walked away does
 * not block the next one.
 */

interface Binding {
  readonly principal: string;
  readonly domain: string;
}

export class SessionQuota {
  /** principal -> domain -> session id -> last activity, oldest first on ties. */
  private readonly buckets = new Map<string, Map<string, Map<string, number>>>();
  private readonly bindings = new Map<string, Binding>();

  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records activity for a session holding a target; a no-op for any other. */
  touch(sessionId: string): void {
    const binding = this.bindings.get(sessionId);
    if (binding === undefined) return;
    const bucket = this.buckets.get(binding.principal)?.get(binding.domain);
    if (bucket?.has(sessionId) === true) bucket.set(sessionId, this.now());
  }

  /**
   * Binds `sessionId` to its bucket and returns the session to reclaim when
   * the bucket is over the limit, or undefined when it is not. The returned
   * session is already out of the bookkeeping: the caller closes it.
   */
  occupy(sessionId: string, principal: string, domain: string): string | undefined {
    this.release(sessionId);
    let byDomain = this.buckets.get(principal);
    if (byDomain === undefined) {
      byDomain = new Map();
      this.buckets.set(principal, byDomain);
    }
    let bucket = byDomain.get(domain);
    if (bucket === undefined) {
      bucket = new Map();
      byDomain.set(domain, bucket);
    }
    bucket.set(sessionId, this.now());
    this.bindings.set(sessionId, { principal, domain });
    if (bucket.size <= this.limit) return undefined;
    let oldestId: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [id, at] of bucket) {
      if (id !== sessionId && at < oldest) {
        oldest = at;
        oldestId = id;
      }
    }
    if (oldestId === undefined) return undefined;
    bucket.delete(oldestId);
    this.bindings.delete(oldestId);
    return oldestId;
  }

  /** Drops a session's binding and its bucket entry. */
  release(sessionId: string): void {
    const binding = this.bindings.get(sessionId);
    if (binding === undefined) return;
    this.bindings.delete(sessionId);
    const byDomain = this.buckets.get(binding.principal);
    const bucket = byDomain?.get(binding.domain);
    if (byDomain === undefined || bucket === undefined) return;
    bucket.delete(sessionId);
    if (bucket.size > 0) return;
    byDomain.delete(binding.domain);
    if (byDomain.size === 0) this.buckets.delete(binding.principal);
  }
}
