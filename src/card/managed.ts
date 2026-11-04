import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

interface ManagedEntry {
  kind: 'card-id' | 'raw-card';
  cardId?: string;
  sequence: number;
}

// Module-local because state is per-process. Lost on restart, which is fine —
// a new run of /account will mint a fresh card.
const byMessageId = new Map<string, ManagedEntry>();

export interface ManagedCardSendResult {
  messageId: string;
  cardId: string;
}

/**
 * Create a CardKit 2.0 card entity and send a message that references it.
 * Returns both ids; we keep them in a module-local map so future cardAction
 * events can update the card by its messageId.
 *
 * `recipientId` is routed by its id prefix (channel.send infers
 * `receive_id_type`): `oc_*` → chat, `ou_*` → direct message to that user
 * (Lark auto-resolves the p2p chat). If `replyTo` is provided, the card
 * threads under that message — only meaningful for chat sends.
 */
export async function sendManagedCard(
  channel: LarkChannel,
  recipientId: string,
  card: object,
  opts: { replyTo?: string; replyInThread?: boolean } = {},
): Promise<ManagedCardSendResult> {
  const { cardId } = await channel.createCard(card);
  const sendOpts = opts.replyTo
    ? { replyTo: opts.replyTo, ...(opts.replyInThread ? { replyInThread: true } : {}) }
    : undefined;
  let messageId: string;
  try {
    ({ messageId } = await channel.send(recipientId, { cardId }, sendOpts));
  } catch (err) {
    log.warn('card', 'managed-send-raw-fallback', {
      err: err instanceof Error ? err.message : String(err),
      replyTo: opts.replyTo,
      replyInThread: opts.replyInThread === true,
    });
    ({ messageId } = await channel.send(recipientId, { card }, sendOpts));
    byMessageId.set(messageId, { kind: 'raw-card', sequence: 0 });
    return { messageId, cardId };
  }
  byMessageId.set(messageId, { kind: 'card-id', cardId, sequence: 0 });
  return { messageId, cardId };
}

/**
 * Update a managed card identified by the messageId of the message that
 * carries it.
 *
 * Two writes are possible and neither is sufficient on its own:
 *
 *  - `cardkit.v1.card.update` targets the shared card entity, and is the only
 *    write that reaches every message referencing that entity. It has been
 *    observed to report success while the message carrying the card kept
 *    rendering the previous content — an answered permission card then still
 *    looks unanswered, which is exactly the signal the greying-out exists to
 *    give.
 *  - `im.v1.message.patch` targets this one message, and is what the reader
 *    actually sees change.
 *
 * So send both, and only fail when both fail. The entity write keeps any other
 * reference in sync; the patch is what makes this message right.
 */
export async function updateManagedCard(
  channel: LarkChannel,
  messageId: string,
  card: object,
): Promise<void> {
  const entry = byMessageId.get(messageId);
  if (!entry) {
    throw new Error(`no managed card registered for message ${messageId}`);
  }
  entry.sequence += 1;

  const patchErr = await patchMessage(channel, messageId, card);
  const entityErr =
    entry.kind === 'card-id' ? await updateEntity(channel, entry, card, messageId) : undefined;

  if (patchErr && entityErr) throw entityErr;
}

/**
 * Card-entity write. The sequence must increase per card — the card server
 * rejects stale ones rather than letting a slow update clobber a newer one.
 * Best-effort: the message patch is what the reader sees, so a failure here is
 * reported and returned, not thrown.
 */
async function updateEntity(
  channel: LarkChannel,
  entry: ManagedEntry,
  card: object,
  messageId: string,
): Promise<unknown> {
  try {
    await channel.updateCardById(entry.cardId!, card, entry.sequence);
    log.info('card', 'managed-updated', {
      messageId,
      cardId: entry.cardId,
      seq: entry.sequence,
      summary: summaryOf(card),
    });
    return undefined;
  } catch (err) {
    log.fail('card', err, { step: 'managed-update', cardId: entry.cardId, seq: entry.sequence });
    return err;
  }
}

/** Message write — the one the reader sees. Best-effort, same as the above. */
async function patchMessage(
  channel: LarkChannel,
  messageId: string,
  card: object,
): Promise<unknown> {
  try {
    await channel.updateCard(messageId, card);
    log.info('card', 'managed-patched', { messageId, summary: summaryOf(card) });
    return undefined;
  } catch (err) {
    log.fail('card', err, { step: 'managed-patch', messageId });
    return err;
  }
}

function summaryOf(card: unknown): unknown {
  const config = (card as { config?: { summary?: { content?: unknown } } } | undefined)?.config;
  return config?.summary?.content;
}

/** True iff we have the card_id mapping for this messageId. */
export function isManaged(messageId: string): boolean {
  return byMessageId.has(messageId);
}

/** Drop the mapping; call after the card is recalled or the flow ends. */
export function forgetManagedCard(messageId: string): void {
  byMessageId.delete(messageId);
}
