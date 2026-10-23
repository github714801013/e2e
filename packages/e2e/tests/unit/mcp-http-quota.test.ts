import { describe, expect, it } from 'vitest';
import { SessionQuota } from '../../src/mcp/http/quota.ts';

/** A clock that ticks once per call, so the least recently active is exact. */
function quota(limit: number): SessionQuota {
  let tick = 0;
  return new SessionQuota(limit, () => {
    tick += 1;
    return tick;
  });
}

describe('SessionQuota', () => {
  it('admits up to the limit of one principal on one domain without reclaiming', () => {
    const sessions = quota(2);
    expect(sessions.occupy('a', 'alpha', 'oa.example.com')).toBeUndefined();
    expect(sessions.occupy('b', 'alpha', 'oa.example.com')).toBeUndefined();
  });

  it('reclaims the least recently active session of its own bucket', () => {
    const sessions = quota(2);
    sessions.occupy('a', 'alpha', 'oa.example.com');
    sessions.occupy('b', 'alpha', 'oa.example.com');
    sessions.touch('a');
    expect(sessions.occupy('c', 'alpha', 'oa.example.com')).toBe('b');
  });

  it('keeps principals and domains apart', () => {
    const sessions = quota(1);
    expect(sessions.occupy('a', 'alpha', 'oa.example.com')).toBeUndefined();
    expect(sessions.occupy('b', 'bravo', 'oa.example.com')).toBeUndefined();
    expect(sessions.occupy('c', 'alpha', 'other.example.com')).toBeUndefined();
  });

  it('frees a slot when a session releases its target', () => {
    const sessions = quota(1);
    sessions.occupy('a', 'alpha', 'oa.example.com');
    sessions.release('a');
    expect(sessions.occupy('b', 'alpha', 'oa.example.com')).toBeUndefined();
  });

  it('moves a session out of its old bucket when it opens another target', () => {
    const sessions = quota(1);
    sessions.occupy('a', 'alpha', 'one.example.com');
    expect(sessions.occupy('a', 'alpha', 'two.example.com')).toBeUndefined();
    sessions.release('a');
    expect(sessions.occupy('b', 'alpha', 'one.example.com')).toBeUndefined();
    expect(sessions.occupy('c', 'alpha', 'two.example.com')).toBeUndefined();
  });
});
