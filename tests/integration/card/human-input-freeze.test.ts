import type { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import type { PendingHumanInput } from '../../../src/agent/human-input/types';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { CallbackAuth } from '../../../src/card/callback-auth.js';
import { CallbackNonceStore } from '../../../src/card/callback-store.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import { LarkHumanInputRenderer } from '../../../src/card/human-input-renderer.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * The real renderer wired to the real dispatcher. The unit tests pin the card
 * layout; this pins the wiring between a click and the repaint, which is what
 * actually has to hold for a card to visibly grey out in the chat.
 */
describe('freezing a card after a click', () => {
  it('repaints the card as settled when the answer lands', async () => {
    const h = await createHarness();

    await h.renderer.render(h.pending);
    const openCard = renderedCard(h.channel);
    expect(summaryOf(openCard)).toBe('🔐 需要你的许可');

    await h.click('allow-once');

    const settled = settledCards(h.channel);
    expect(settled).toHaveLength(1);
    expect(summaryOf(cardAt(settled, 0))).toBe('✅ 已允许一次');
    // Greyed out is the whole point: the answer must be visible to everyone,
    // not just to whoever tapped.
    for (const button of buttonNodes(cardAt(settled, 0))) {
      expect(button.disabled).toBe(true);
    }
    expect(markdownOf(cardAt(settled, 0))).toContain('由 邵加一 操作');
  });

  it('writes the settled card to the message the click came from', async () => {
    const h = await createHarness();
    await h.renderer.render(h.pending);
    await h.click('deny');

    // The card entity update alone has been seen to report success while the
    // message kept showing the question, so the clicked message is patched too.
    const patched = h.channel.rawClient.requests.filter((r) => r.method === 'im.v1.message.patch');
    expect(patched).toHaveLength(1);
    const params = patched[0]?.params as { messageId: string; cardJson: object };
    expect(params.messageId).toBe('om_fake_1');
    expect(summaryOf(params.cardJson)).toBe('🚫 已拒绝');
  });

  it('freezes by card id as well, so other references see the answer', async () => {
    const h = await createHarness();
    await h.renderer.render(h.pending);
    await h.click('deny');

    const update = h.channel.rawClient.requests.find(
      (r) => r.method === 'cardkit.v1.card.update',
    );
    expect(update).toBeDefined();
    const params = update?.params as { cardId: string; sequence: number };
    expect(params.cardId).toMatch(/^card_fake_/);
    expect(params.sequence).toBe(1);
  });

  it('leaves the card answerable when a click is refused', async () => {
    const h = await createHarness();
    await h.renderer.render(h.pending);

    await h.click('allow-once', { operatorOpenId: 'ou_someone_else' });

    const shown = settledCards(h.channel);
    expect(shown).toHaveLength(1);
    // A refusal explains itself without consuming the question.
    expect(summaryOf(cardAt(shown, 0))).toBe('🔐 需要你的许可');
    expect(markdownOf(cardAt(shown, 0))).toContain('只能由发起该请求的人操作');
    for (const button of buttonNodes(cardAt(shown, 0))) expect(button.disabled).toBeUndefined();
  });
});

type Harness = {
  channel: FakeChannel;
  renderer: LarkHumanInputRenderer;
  pending: PendingHumanInput;
  click(
    choice: 'allow-once' | 'allow-always' | 'deny',
    overrides?: { operatorOpenId?: string },
  ): Promise<void>;
};

async function createHarness(): Promise<Harness> {
  const tmp = await createTmpProfile('human-input-freeze-test-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter();
  const pending = new PendingQueue(60_000, () => {});
  const store = new CallbackNonceStore(`${tmp.profile}/callback-nonces.json`);
  let nonce = 0;
  const auth = new CallbackAuth({
    keys: [{ version: 1, secret: 'secret-1' }],
    nonceStore: store,
    now: () => 1000,
    createNonce: () => `nonce-${nonce++}`,
  });
  const chatModeCache = { resolve: async () => 'group' } as unknown as ChatModeCache;
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { allowedChats: ['oc_group'] },
  });
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou_owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.profile}/config.json`,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), store.flush()]);
    await tmp.cleanup();
  });

  const question: PendingHumanInput = {
    requestId: 'req-freeze',
    runId: 'run-freeze',
    scope: 'oc_group',
    kind: 'can_use_tool',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Write',
      tool_use_id: 'toolu_1',
      input: { file_path: '/tmp/x.txt' },
    },
    askedAt: 1000,
  };

  const renderer = new LarkHumanInputRenderer({
    getChannel: () => channel as unknown as LarkChannel,
    resolveChatId: (scope) => scope,
    // The dispatcher repaints detached from the click handler; skip the
    // client-settle wait and flush the microtask queue below instead.
    settleDelayMs: 0,
    signCallback: (scope, action) =>
      auth.sign({
        runId: question.runId,
        scope,
        chatId: 'oc_group',
        operatorOpenId: 'ou_operator',
        action,
        policyFingerprint: 'fp-1',
        ttlMs: 60_000,
      }),
  });
  activeRuns.register('oc_group', agent.run({ runId: question.runId, prompt: 'parked' }));

  return {
    channel,
    renderer,
    pending: question,
    async click(choice, overrides = {}) {
      const token = buttonValues(renderedCard(channel)).find((v) => v.choice === choice)
        ?.bridge_token as string;
      await handleCardAction({
        channel: channel as never,
        evt: {
          action: { value: { __bridge_hitl: true, request_id: question.requestId, choice, bridge_token: token } },
          chatId: 'oc_group',
          messageId: 'om_fake_1',
          operator: { openId: overrides.operatorOpenId ?? 'ou_operator', name: '邵加一' },
        } as never,
        sessions,
        workspaces,
        activeRuns,
        agent,
        controls,
        pending,
        chatModeCache,
        callbackAuth: auth,
        callbackPolicyFingerprint: 'fp-1',
        humanInput: { answer: () => true } as never,
        humanInputRenderer: renderer,
      });
      // The repaint is detached from the handler; let it run.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}

function renderedCard(channel: FakeChannel): object {
  const last = channel.sent.at(-1);
  return (last?.content as { card?: object } | undefined)?.card ?? {};
}

/** The card JSON written to the clicked message — what the reader ends up seeing. */
function settledCards(channel: FakeChannel): object[] {
  return channel.rawClient.requests
    .filter((r) => r.method === 'im.v1.message.patch')
    .map((r) => (r.params as { cardJson: object }).cardJson);
}

/** The nth element of a list the test just asserted is non-empty. */
function cardAt(cards: object[], index: number): object {
  const card = cards[index];
  if (!card) throw new Error(`no card at index ${index}`);
  return card;
}

function summaryOf(card: object): unknown {
  return (card as { config?: { summary?: { content?: unknown } } }).config?.summary?.content;
}

function buttonNodes(card: object): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  walk(card, (node) => {
    if (node.tag === 'button') found.push(node);
  });
  return found;
}

function buttonValues(card: object): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  walk(card, (node) => {
    if (node.tag !== 'button' || !Array.isArray(node.behaviors)) return;
    for (const behavior of node.behaviors as Array<Record<string, unknown>>) {
      if (behavior.type === 'callback' && behavior.value) {
        found.push(behavior.value as Record<string, unknown>);
      }
    }
  });
  return found;
}

function markdownOf(card: object): string {
  const parts: string[] = [];
  walk(card, (node) => {
    if (node.tag === 'markdown' && typeof node.content === 'string') parts.push(node.content);
  });
  return parts.join('\n');
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  visit(node);
  for (const child of Object.values(node)) walk(child, visit);
}
