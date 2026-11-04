import type { LarkChannel } from '@larksuite/channel';
import type { HumanInputRenderer } from '../agent/human-input/broker';
import type { HumanInputKind, PendingHumanInput } from '../agent/human-input/types';
import { log } from '../core/logger';
import { sendManagedCard, updateManagedCard, forgetManagedCard } from './managed';
import { dialogFallbackCard, toolPermissionCard, type PermissionCardOptions } from './permission-card';
import type { PermissionChoice } from './permission-decision';

/**
 * Dialog kinds we have a layout for. The broker turns this into the
 * `initialize.supportedDialogKinds` handshake, and the CLI fails closed on
 * anything absent — so adding a kind here is what opts the bridge into
 * handling it. Keep it to kinds whose payload we can render honestly.
 */
const SUPPORTED_DIALOG_KINDS: readonly HumanInputKind[] = ['dialog:repository_trust'];

export interface LarkHumanInputRendererDeps {
  /**
   * Resolved lazily: the channel is constructed after the broker it feeds,
   * but it always exists by the time a question is rendered.
   */
  getChannel: () => LarkChannel;
  /** chatId to post into, derived from the run's scope. */
  resolveChatId: (scope: string) => string;
  /** Signs a callback so only a legitimate click can answer. */
  signCallback?: (scope: string, action: string) => string | undefined;
  /**
   * How long to wait before repainting an answered card. Lark's client keeps
   * the card locked while the cardAction handler that received the click is
   * pending, and restores its cached copy as soon as that handler returns —
   * which overwrites a repaint made in the meantime. The dispatcher therefore
   * returns before repainting, and this is the round trip it waits out. The
   * same trap is documented on the /account form in `commands/index.ts`.
   */
  settleDelayMs?: number;
}

/** See {@link LarkHumanInputRendererDeps.settleDelayMs}. */
const DEFAULT_SETTLE_DELAY_MS = 1000;

interface SentCard {
  messageId: string;
  pending: PendingHumanInput;
}

/**
 * Renders parked questions as Lark cards and freezes them once answered.
 *
 * The click itself does NOT come back through here — it lands in the card
 * dispatcher, which calls `decisionFor()` and hands the result to the
 * broker. This class only owns presentation.
 */
export class LarkHumanInputRenderer implements HumanInputRenderer {
  readonly kinds: readonly HumanInputKind[] = ['can_use_tool', ...SUPPORTED_DIALOG_KINDS];

  private readonly deps: LarkHumanInputRendererDeps;
  private readonly sent = new Map<string, SentCard>();

  constructor(deps: LarkHumanInputRendererDeps) {
    this.deps = deps;
  }

  async render(pending: PendingHumanInput): Promise<void> {
    const chatId = this.deps.resolveChatId(pending.scope);
    const { messageId } = await sendManagedCard(
      this.deps.getChannel(),
      chatId,
      this.cardFor(pending),
    );
    this.sent.set(pending.requestId, { messageId, pending });
  }

  /**
   * Repaint a still-open card with a line explaining why a click was refused.
   *
   * Deliberately non-destructive: the question is still unanswered, so the
   * buttons stay live and the person who is allowed to answer still can. A
   * click on an unknown or already-settled request is a no-op.
   */
  async notice(requestId: string, text: string): Promise<void> {
    const entry = this.sent.get(requestId);
    if (!entry) return;
    await this.waitForClientUnlock();
    await updateManagedCard(
      this.deps.getChannel(),
      entry.messageId,
      this.cardFor(entry.pending, { notice: text }),
    );
  }

  async withdraw(pending: PendingHumanInput): Promise<void> {
    await this.freeze(pending.requestId, { choice: 'withdrawn' });
  }

  /** Freeze the card after a human chose, so it cannot be clicked again. */
  async settle(
    requestId: string,
    choice: PermissionChoice,
    operatorName?: string,
  ): Promise<void> {
    await this.freeze(requestId, { choice, ...(operatorName ? { operatorName } : {}) });
  }

  /** The pending question a click refers to, if it is still open. */
  pendingFor(requestId: string): PendingHumanInput | undefined {
    return this.sent.get(requestId)?.pending;
  }

  private async freeze(
    requestId: string,
    settled: { choice: PermissionChoice | 'withdrawn'; operatorName?: string },
  ): Promise<void> {
    const entry = this.sent.get(requestId);
    if (!entry) {
      log.info('human-input', 'card-freeze-no-entry', { requestId, choice: settled.choice });
      return;
    }
    this.sent.delete(requestId);
    log.info('human-input', 'card-freezing', {
      requestId,
      messageId: entry.messageId,
      choice: settled.choice,
    });

    try {
      await this.waitForClientUnlock();
      await updateManagedCard(
        this.deps.getChannel(),
        entry.messageId,
        this.cardFor(entry.pending, { settled }),
      );
    } catch (err) {
      // A card we cannot repaint is cosmetic — the decision already went
      // to the CLI. Log and move on rather than failing the run.
      log.warn('human-input', 'card-freeze-failed', {
        requestId,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      forgetManagedCard(entry.messageId);
    }
  }

  private async waitForClientUnlock(): Promise<void> {
    const delay = this.deps.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;
    if (delay <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  private cardFor(
    pending: PendingHumanInput,
    extra: Omit<PermissionCardOptions, 'pending' | 'signCallback'> = {},
  ): object {
    const signCallback = this.deps.signCallback
      ? (action: string) => this.deps.signCallback!(pending.scope, action) ?? ''
      : undefined;
    const options: PermissionCardOptions = { pending, ...(signCallback ? { signCallback } : {}), ...extra };
    return pending.kind === 'can_use_tool'
      ? toolPermissionCard(options)
      : dialogFallbackCard(options);
  }
}
