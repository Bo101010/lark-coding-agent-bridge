import { describe, expect, it } from 'vitest';
import { ProcessPool } from '../../../src/bot/process-pool';
import { PoolSlotParkingLot } from '../../../src/runtime/pool-parking-lot';
import type { PendingHumanInput } from '../../../src/agent/human-input/types';

describe('PoolSlotParkingLot', () => {
  it('frees the slot while a run waits on a human', async () => {
    const pool = new ProcessPool(() => 1);
    const lot = new PoolSlotParkingLot(pool);
    lot.track('run-1', await pool.acquire());

    // Cap is 1 and the run holds it, so nothing else can start yet.
    expect(pool.tryAcquire()).toBeUndefined();

    await lot.observer()(pending('run-1'));

    // Parked: the slot is back, so an unrelated chat can run.
    const other = pool.tryAcquire();
    expect(other).toBeDefined();
    other?.();
  });

  it('takes a slot again before the run resumes', async () => {
    const pool = new ProcessPool(() => 1);
    const lot = new PoolSlotParkingLot(pool);
    lot.track('run-1', await pool.acquire());

    const resume = await lot.observer()(pending('run-1'));
    expect(typeof resume).toBe('function');

    await (resume as () => Promise<void>)();

    // Resumed: the run is counted against the cap again.
    expect(pool.tryAcquire()).toBeUndefined();
  });

  it('hands back the reacquired slot, not the stale one', async () => {
    const pool = new ProcessPool(() => 1);
    const lot = new PoolSlotParkingLot(pool);
    lot.track('run-1', await pool.acquire());

    const resume = await lot.observer()(pending('run-1'));
    await (resume as () => Promise<void>)();

    // Releasing via the lot must free the slot the run actually holds;
    // releasing the original closure would over-credit the pool.
    lot.takeRelease('run-1')?.();

    const a = pool.tryAcquire();
    expect(a).toBeDefined();
    // Cap is 1 — a second acquire proves nothing was double-released.
    expect(pool.tryAcquire()).toBeUndefined();
    a?.();
  });

  it('does not release anything for a run parked at cleanup time', async () => {
    const pool = new ProcessPool(() => 1);
    const lot = new PoolSlotParkingLot(pool);
    lot.track('run-1', await pool.acquire());
    await lot.observer()(pending('run-1'));

    // Still parked (slot already given back) — cleanup must be a no-op.
    lot.takeRelease('run-1')?.();

    const a = pool.tryAcquire();
    expect(a).toBeDefined();
    expect(pool.tryAcquire()).toBeUndefined();
    a?.();
  });

  it('ignores a run it never tracked', async () => {
    const pool = new ProcessPool(() => 1);
    const lot = new PoolSlotParkingLot(pool);
    await expect(lot.observer()(pending('unknown'))).resolves.toBeUndefined();
    expect(lot.takeRelease('unknown')).toBeUndefined();
  });

  it('lets a parked run yield to another chat and resume after it finishes', async () => {
    const pool = new ProcessPool(() => 1);
    const lot = new PoolSlotParkingLot(pool);
    lot.track('run-1', await pool.acquire());

    const resume = await lot.observer()(pending('run-1'));

    // Another chat grabs the freed slot while the human is deciding.
    const otherRelease = await pool.acquire();

    let resumed = false;
    const resuming = (resume as () => Promise<void>)().then(() => {
      resumed = true;
    });
    await Promise.resolve();
    expect(resumed).toBe(false);

    otherRelease();
    await resuming;
    expect(resumed).toBe(true);
  });
});

function pending(runId: string): PendingHumanInput {
  return {
    requestId: `req-${runId}`,
    runId,
    scope: 'oc_x',
    kind: 'can_use_tool',
    request: { subtype: 'can_use_tool', tool_name: 'Bash' },
    askedAt: Date.now(),
  };
}
