import type { ProcessPool } from '../bot/process-pool';
import type { ParkObserver } from '../agent/human-input/broker';
import { log } from '../core/logger';

/**
 * Hands a run's process-pool slot back while it waits on a human, and takes
 * one again before it resumes.
 *
 * A run parked on a permission card is not doing work — it is blocked on a
 * button click that may never come, since parked questions have no
 * deadline. Holding a concurrency slot for it would let a few unanswered
 * cards starve every other chat of runs.
 *
 * Scope exclusivity is deliberately NOT released: the conversation really
 * is still mid-run, and a second run in the same scope would race the first
 * one's session.
 */
export class PoolSlotParkingLot {
  private readonly pool: ProcessPool;
  private readonly slots = new Map<string, () => void>();
  /** Runs currently holding no slot because they are awaiting a human. */
  private readonly parked = new Set<string>();

  constructor(pool: ProcessPool) {
    this.pool = pool;
  }

  /** Register the slot a run currently holds, so it can be parked later. */
  track(runId: string, release: () => void): void {
    this.slots.set(runId, release);
  }

  /**
   * Hand back the release closure for a finishing run and stop tracking it.
   * Returns undefined when the run is parked (its slot is already given
   * back) or was never tracked, so the caller can fall back to its own.
   */
  takeRelease(runId: string): (() => void) | undefined {
    const release = this.slots.get(runId);
    this.slots.delete(runId);
    // A parked run holds no slot; `noop` keeps the caller from releasing a
    // stale closure and over-crediting the pool.
    return release ?? (this.parked.has(runId) ? noop : undefined);
  }

  /** Run finished: forget its slot without releasing it (the caller does). */
  forget(runId: string): void {
    this.slots.delete(runId);
    this.parked.delete(runId);
  }

  /** Broker hook: release on park, re-acquire before the answer is sent. */
  observer(): ParkObserver {
    return async (pending) => {
      const release = this.slots.get(pending.runId);
      if (!release) return undefined;

      this.slots.delete(pending.runId);
      this.parked.add(pending.runId);
      release();
      log.info('pool', 'parked-for-human-input', {
        runId: pending.runId,
        scope: pending.scope,
        kind: pending.kind,
      });

      return async () => {
        this.parked.delete(pending.runId);
        // Waits for a free slot if the pool filled up while the human was
        // thinking. The run is already mid-turn, so it queues ahead of
        // nothing — but it does respect the cap rather than blowing past it.
        const reacquired = await this.pool.acquire();
        this.slots.set(pending.runId, reacquired);
        log.info('pool', 'resumed-after-human-input', {
          runId: pending.runId,
          scope: pending.scope,
        });
      };
    };
  }
}

function noop(): void {
  /* the run holds no slot while parked */
}
