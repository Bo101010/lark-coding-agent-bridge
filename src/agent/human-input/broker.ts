import { log } from '../../core/logger';
import type {
  CanUseToolRequest,
  ControlRequestEnvelope,
  HumanInputAnswer,
  HumanInputKind,
  PendingHumanInput,
  RequestUserDialogRequest,
} from './types';

/**
 * Renders a parked question to a human and returns once it has been
 * presented. Answering happens out-of-band via `HumanInputBroker.answer()`
 * (a Lark card click lands in the dispatcher, not here), so a renderer only
 * has to deliver the prompt — it must not block waiting for the reply.
 */
export interface HumanInputRenderer {
  /**
   * The `dialog_kind` values this renderer can display, or `can_use_tool`.
   * These are what the adapter declares in `initialize.supportedDialogKinds`.
   */
  readonly kinds: readonly HumanInputKind[];
  render(pending: PendingHumanInput): Promise<void>;
  /** The CLI withdrew the request — take the prompt down if it is still up. */
  withdraw?(pending: PendingHumanInput, reason: 'cancelled' | 'run-ended'): Promise<void>;
}

/**
 * Called when a question parks and when it settles. The run executor uses
 * this to hand its process-pool slot back while a human is thinking, and to
 * reacquire one before the run resumes (plan "B"): a run waiting on a button
 * click is not doing work and should not count against the concurrency cap.
 *
 * `onPark` may return a function that re-acquires the slot; the broker awaits
 * it before delivering the answer to the CLI.
 */
export type ParkObserver = (pending: PendingHumanInput) => Promise<(() => Promise<void>) | void>;

export interface HumanInputBrokerOptions {
  renderers: readonly HumanInputRenderer[];
  onPark?: ParkObserver;
}

interface ParkedEntry {
  pending: PendingHumanInput;
  renderer: HumanInputRenderer;
  settle: (answer: HumanInputAnswer | undefined) => void;
  resume?: () => Promise<void>;
}

/**
 * Registry of questions the CLI has asked and a human has not yet answered.
 *
 * There is deliberately NO timeout: a parked question waits indefinitely.
 * The CLI's own 5-minute dialog deadline is disabled by the adapter, so the
 * only ways out are answering it or `/stop`. This is a product decision —
 * auto-denying someone's run because they stepped away is worse than making
 * them stop it explicitly.
 */
export class HumanInputBroker {
  private readonly byKind = new Map<HumanInputKind, HumanInputRenderer>();
  private readonly parked = new Map<string, ParkedEntry>();
  private readonly onPark: ParkObserver | undefined;

  constructor(options: HumanInputBrokerOptions) {
    this.onPark = options.onPark;
    for (const renderer of options.renderers) {
      for (const kind of renderer.kinds) {
        if (this.byKind.has(kind)) {
          throw new Error(`duplicate human-input renderer for kind: ${kind}`);
        }
        this.byKind.set(kind, renderer);
      }
    }
  }

  /**
   * Dialog kinds to declare in the initialize handshake.
   *
   * The CLI fails closed: a kind absent from this list is never sent, and
   * the flow gating on it silently degrades to its no-dialog behavior.
   * Deriving the list from the registry makes it impossible to declare a
   * kind we cannot actually render — which the CLI rejects outright.
   */
  supportedDialogKinds(): string[] {
    const kinds: string[] = [];
    for (const kind of this.byKind.keys()) {
      if (kind.startsWith('dialog:')) kinds.push(kind.slice('dialog:'.length));
    }
    return kinds.sort();
  }

  /**
   * Park a control_request until a human answers it.
   *
   * Resolves with the answer to send back, or `undefined` when the question
   * was withdrawn (CLI cancel / run teardown) and no reply should be sent.
   */
  async ask(
    envelope: ControlRequestEnvelope,
    context: { runId: string; scope: string },
  ): Promise<HumanInputAnswer | undefined> {
    const kind = kindOf(envelope.request);
    const renderer = this.byKind.get(kind);
    if (!renderer) {
      // Should be unreachable for dialogs (we only declare what we render),
      // but can_use_tool arrives regardless of what we declared.
      log.warn('human-input', 'no-renderer', { kind, runId: context.runId });
      return undefined;
    }

    const pending: PendingHumanInput = {
      requestId: envelope.request_id,
      runId: context.runId,
      scope: context.scope,
      kind,
      request: envelope.request,
      askedAt: Date.now(),
    };

    const answer = await new Promise<HumanInputAnswer | undefined>((resolve) => {
      const entry: ParkedEntry = { pending, renderer, settle: resolve };
      this.parked.set(envelope.request_id, entry);

      void (async () => {
        try {
          // Hand back the pool slot before rendering: if the render itself
          // is slow we are already not doing useful work.
          const resume = await this.onPark?.(pending);
          if (typeof resume === 'function') entry.resume = resume;
          await renderer.render(pending);
          log.info('human-input', 'parked', {
            kind,
            scope: context.scope,
            runId: context.runId,
            requestId: envelope.request_id,
          });
        } catch (err) {
          log.fail('human-input', err, { step: 'render', kind, runId: context.runId });
          // Nobody can answer a prompt that failed to render — settle it
          // rather than wedging the run forever on an invisible question.
          this.settleEntry(envelope.request_id, undefined);
        }
      })();
    });

    const entry = this.parked.get(envelope.request_id);
    if (entry?.resume) await entry.resume().catch(() => {});
    this.parked.delete(envelope.request_id);
    return answer;
  }

  /** Deliver a human's answer. Returns false if nothing was waiting on it. */
  answer(requestId: string, answer: HumanInputAnswer): boolean {
    const entry = this.parked.get(requestId);
    if (!entry) {
      log.info('human-input', 'answer-stale', { requestId });
      return false;
    }
    log.info('human-input', 'answered', {
      kind: entry.pending.kind,
      scope: entry.pending.scope,
      requestId,
      waitedMs: Date.now() - entry.pending.askedAt,
    });
    this.settleEntry(requestId, answer);
    return true;
  }

  /** The CLI withdrew this request; stop waiting and take the prompt down. */
  cancel(requestId: string, reason: 'cancelled' | 'run-ended' = 'cancelled'): void {
    const entry = this.parked.get(requestId);
    if (!entry) return;
    log.info('human-input', 'withdrawn', { requestId, reason, kind: entry.pending.kind });
    void entry.renderer.withdraw?.(entry.pending, reason).catch((err: unknown) => {
      log.fail('human-input', err, { step: 'withdraw', requestId });
    });
    this.settleEntry(requestId, undefined);
  }

  /** Tear down every question parked for a run (used when the run stops). */
  cancelRun(runId: string): void {
    for (const [requestId, entry] of this.parked) {
      if (entry.pending.runId === runId) this.cancel(requestId, 'run-ended');
    }
  }

  /** Questions currently awaiting a human in this scope. */
  pendingForScope(scope: string): PendingHumanInput[] {
    const out: PendingHumanInput[] = [];
    for (const entry of this.parked.values()) {
      if (entry.pending.scope === scope) out.push(entry.pending);
    }
    return out;
  }

  private settleEntry(requestId: string, answer: HumanInputAnswer | undefined): void {
    const entry = this.parked.get(requestId);
    if (!entry) return;
    entry.settle(answer);
  }
}

function kindOf(request: CanUseToolRequest | RequestUserDialogRequest): HumanInputKind {
  return request.subtype === 'can_use_tool' ? 'can_use_tool' : `dialog:${request.dialog_kind}`;
}
