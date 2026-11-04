import { describe, expect, it, vi } from 'vitest';
import { sendManagedCard, updateManagedCard } from '../../../src/card/managed.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel';

describe('managed card sending', () => {
  it('falls back to sending the raw card when the card_id message is rejected', async () => {
    const channel = {
      createCard: vi.fn(async () => ({ cardId: 'card_1' })),
      send: vi.fn()
        .mockRejectedValueOnce(new Error('cardid is invalid'))
        .mockResolvedValueOnce({ messageId: 'om_raw' }),
    };

    const result = await sendManagedCard(
      channel as never,
      'oc_chat',
      { type: 'template', data: { template_id: 'tpl' } },
      { replyTo: 'om_parent', replyInThread: true },
    );

    expect(result).toEqual({ messageId: 'om_raw', cardId: 'card_1' });
    expect(channel.send).toHaveBeenNthCalledWith(
      1,
      'oc_chat',
      { cardId: 'card_1' },
      { replyTo: 'om_parent', replyInThread: true },
    );
    expect(channel.send).toHaveBeenNthCalledWith(
      2,
      'oc_chat',
      { card: { type: 'template', data: { template_id: 'tpl' } } },
      { replyTo: 'om_parent', replyInThread: true },
    );
  });

  it('updates card-id managed messages by card id and by message id', async () => {
    const channel = {
      createCard: vi.fn(async () => ({ cardId: 'card_normal' })),
      send: vi.fn(async () => ({ messageId: 'om_normal' })),
      updateCardById: vi.fn(async () => {}),
      updateCard: vi.fn(async () => {}),
    };

    await sendManagedCard(channel as never, 'oc_chat', { body: 'form' });
    await updateManagedCard(channel as never, 'om_normal', { body: 'cancelled' });

    expect(channel.updateCardById).toHaveBeenCalledWith('card_normal', { body: 'cancelled' }, 1);
    // The entity write alone has been seen to report success while the message
    // kept rendering the old card, so the message is patched as well.
    expect(channel.updateCard).toHaveBeenCalledWith('om_normal', { body: 'cancelled' });
  });

  it('updates raw-card fallback messages by message id', async () => {
    const channel = {
      createCard: vi.fn(async () => ({ cardId: 'card_raw' })),
      send: vi.fn()
        .mockRejectedValueOnce(new Error('cardid is invalid'))
        .mockResolvedValueOnce({ messageId: 'om_raw_update' }),
      updateCardById: vi.fn(async () => {}),
      updateCard: vi.fn(async () => {}),
    };

    await sendManagedCard(channel as never, 'oc_chat', { body: 'form' });
    await updateManagedCard(channel as never, 'om_raw_update', { body: 'cancelled' });

    expect(channel.updateCard).toHaveBeenCalledWith('om_raw_update', { body: 'cancelled' });
    expect(channel.updateCardById).not.toHaveBeenCalled();
  });
});

describe('managed card repaints', () => {
  const OPEN = { schema: '2.0', config: { summary: { content: '需要你的许可' } } };
  const SETTLED = { schema: '2.0', config: { summary: { content: '已允许一次' } } };

  it('patches the message as well as the entity', async () => {
    const channel = await sentCard();

    await updateManagedCard(channel as never, 'om_fake_1', SETTLED);

    // The entity write reaches every reference but has been seen to leave the
    // message showing the old card; the patch is what the reader sees change.
    expect(patches(channel)).toEqual([SETTLED]);
    expect(sequences(channel)).toEqual([1]);
  });

  it('still patches when the entity update fails outright', async () => {
    const channel = await sentCard();
    channel.failCardUpdates = true;

    // The entity may be gone while the message is still writable; a card that
    // silently fails to repaint leaves an answered question looking unanswered.
    await updateManagedCard(channel as never, 'om_fake_1', SETTLED);

    expect(patches(channel)).toEqual([SETTLED]);
  });

  it('still updates the entity when the patch fails outright', async () => {
    const channel = await sentCard();
    channel.failCardPatches = true;

    await updateManagedCard(channel as never, 'om_fake_1', SETTLED);

    expect(sequences(channel)).toEqual([1]);
  });

  it('throws only when both writes fail', async () => {
    const channel = await sentCard();
    channel.failCardUpdates = true;
    channel.failCardPatches = true;

    await expect(updateManagedCard(channel as never, 'om_fake_1', SETTLED)).rejects.toThrow();
  });

  it('bumps the sequence on every entity update', async () => {
    const channel = await sentCard();

    await updateManagedCard(channel as never, 'om_fake_1', SETTLED);
    await updateManagedCard(channel as never, 'om_fake_1', OPEN);

    expect(sequences(channel)).toEqual([1, 2]);
  });
});

async function sentCard(): Promise<FakeChannel> {
  const channel = createFakeChannel();
  await sendManagedCard(channel as never, 'oc_group', { body: 'form' });
  return channel;
}

function sequences(channel: FakeChannel): unknown[] {
  return channel.rawClient.requests
    .filter((r) => r.method === 'cardkit.v1.card.update')
    .map((r) => (r.params as { sequence: unknown }).sequence);
}

function patches(channel: FakeChannel): unknown[] {
  return channel.rawClient.requests
    .filter((r) => r.method === 'im.v1.message.patch')
    .map((r) => (r.params as { cardJson: unknown }).cardJson);
}
