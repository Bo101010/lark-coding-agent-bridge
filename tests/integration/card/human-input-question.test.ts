import type { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import type { HumanInputAnswer, PendingHumanInput } from '../../../src/agent/human-input/types';
import {
  checkField,
  choiceField,
  otherField,
} from '../../../src/agent/human-input/user-question';
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
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * An `AskUserQuestion` ask driven through the real renderer and the real
 * dispatcher. The unit tests pin the card layout and the answer encoding; this
 * pins the wiring between a tap or a form submit and the decision that reaches
 * the blocked run — including the `form_value` path, which carries no payload
 * of its own and is the one most likely to be silently dropped.
 */
describe('answering a question card', () => {
  it('falls back to the raw payload for a channel that predates formValue', async () => {
    const h = await createHarness({ multiSelect: true });
    await h.renderer.render(h.pending);

    await h.submitRawOnly({ [checkField(0, 1)]: true });

    expect(h.answer).toMatchObject({
      updatedInput: { answers: { '要哪些依赖？': 'SQLite' } },
    });
  });

  it('answers a one-tap option with the whole answers record', async () => {
    const h = await createHarness();
    await h.renderer.render(h.pending);

    await h.click({ answers: { '用哪个数据库？': 'SQLite' } });

    expect(h.answer).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: h.questions,
        answers: { '用哪个数据库？': 'SQLite' },
      },
    });
  });

  it('reads a form submit back out of form_value', async () => {
    const h = await createHarness({ multiSelect: true });
    await h.renderer.render(h.pending);

    // A form-submitting button carries no answers of its own; the controls
    // arrive on `raw.action.form_value`, which the dispatcher has to forward.
    await h.submit({
      [checkField(0, 0)]: true,
      [checkField(0, 2)]: true,
      [checkField(0, 1)]: false,
    });

    expect(h.answer).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: h.questions,
        answers: { '要哪些依赖？': 'Postgres, Redis' },
      },
    });
  });

  it('lets a typed answer override the dropdown', async () => {
    const h = await createHarness();
    await h.renderer.render(h.pending);

    await h.submit({ [choiceField(0)]: 'Postgres', [otherField(0)]: 'DuckDB' });

    expect(h.answer).toMatchObject({
      updatedInput: { answers: { '用哪个数据库？': 'DuckDB' } },
    });
  });

  it('answers several questions in one submit', async () => {
    const h = await createHarness({ extraQuestion: true });
    await h.renderer.render(h.pending);

    await h.submit({ [choiceField(0)]: 'Postgres', [choiceField(1)]: '要' });

    expect(h.answer).toMatchObject({
      updatedInput: { answers: { '用哪个数据库？': 'Postgres', '要不要迁移？': '要' } },
    });
  });

  it('treats the skip button as a refusal, not an empty answer', async () => {
    const h = await createHarness();
    await h.renderer.render(h.pending);

    await h.click({ choice: 'deny' });

    expect(h.answer).toMatchObject({ behavior: 'deny' });
  });

  it('replays the answers on the frozen card', async () => {
    const h = await createHarness();
    await h.renderer.render(h.pending);

    await h.click({ answers: { '用哪个数据库？': 'SQLite' } });

    const frozen = frozenCards(h.channel);
    expect(frozen).toHaveLength(1);
    expect(summaryOf(cardAt(frozen, 0))).toBe('✅ 已回答');
    const text = markdownOf(cardAt(frozen, 0));
    expect(text).toContain('用哪个数据库？');
    expect(text).toContain('SQLite');
    expect(text).toContain('由 邵加一 操作');
    // The record has to be readable, which means no live controls left.
    expect(nodesOf(cardAt(frozen, 0), 'form')).toHaveLength(0);
  });

  it('submits an empty form as an empty answer, not a refusal', async () => {
    const h = await createHarness({ multiSelect: true });
    await h.renderer.render(h.pending);

    // Nothing ticked: the person did not say no, they just had nothing to
    // add. Recording that honestly beats inventing a refusal.
    await h.submit({});

    expect(h.answer).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: {} },
    });
  });

  it('offers no always button when the question cannot be rendered', async () => {
    const h = await createHarness({ malformed: true });
    await h.renderer.render(h.pending);

    // The run is parked, so the fallback still has to be answerable. What it
    // must not do is offer to persist an allow-rule: `AskUserQuestion` is
    // marked `requires_user_interaction` precisely because a one-tap decision
    // is wrong here, and an auto-allowed ask has nobody to answer it.
    expect(buttonLabels(renderedCard(h.channel))).toEqual(['✅ 允许一次', '🚫 拒绝']);
  });

  it('refuses to answer when the form value never arrived', async () => {
    const h = await createHarness({ multiSelect: true });
    await h.renderer.render(h.pending);

    // A submit button carrying neither answers nor a `form_value` means we
    // never saw what the person typed. Answering "nothing" would look like
    // success; leaving the card open surfaces the break instead.
    await h.click({});

    expect(h.answer).toBeUndefined();
    expect(frozenCards(h.channel)).toHaveLength(0);
  });
});

type Harness = {
  channel: FakeChannel;
  renderer: LarkHumanInputRenderer;
  pending: PendingHumanInput;
  questions: unknown;
  /** What the broker received. Set by the first answer that lands. */
  answer: HumanInputAnswer | undefined;
  click(value: Record<string, unknown>): Promise<void>;
  submit(formValue: Record<string, unknown>): Promise<void>;
  /** Same, but delivering the values the way an older channel build did. */
  submitRawOnly(formValue: Record<string, unknown>): Promise<void>;
};

async function createHarness(
  options: { multiSelect?: boolean; extraQuestion?: boolean; malformed?: boolean } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile('human-input-question-test-');
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

  const questions = [
    options.multiSelect
      ? {
          question: '要哪些依赖？',
          header: '依赖',
          multiSelect: true,
          options: [{ label: 'Postgres' }, { label: 'SQLite' }, { label: 'Redis' }],
        }
      : {
          question: '用哪个数据库？',
          header: '存储',
          multiSelect: false,
          options: [{ label: 'Postgres' }, { label: 'SQLite' }],
        },
    ...(options.extraQuestion
      ? [{ question: '要不要迁移？', header: '迁移', multiSelect: false, options: [{ label: '要' }, { label: '不要' }] }]
      : []),
  ];

  const question: PendingHumanInput = {
    requestId: 'req-question',
    runId: 'run-question',
    scope: 'oc_group',
    kind: 'can_use_tool',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_q',
      requires_user_interaction: true,
      // A question the parser has to reject: `AskUserQuestion` demands at
      // least one option, so an optionless question is exactly the shape that
      // reaches the permission-card fallback.
      input: options.malformed ? { questions: [{ question: '要哪些？', header: '依赖', options: [] }] } : { questions },
    },
    askedAt: 1000,
  };

  const renderer = new LarkHumanInputRenderer({
    getChannel: () => channel as unknown as LarkChannel,
    resolveChatId: (scope) => scope,
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

  let answer: HumanInputAnswer | undefined;
  const harness: Harness = {
    channel,
    renderer,
    pending: question,
    questions,
    get answer() {
      return answer;
    },
    async click(value) {
      await dispatch(value);
    },
    async submit(formValue) {
      // The submit button's own value: the request id and signature, nothing
      // else — everything the person filled in arrives beside it.
      await dispatch({}, formValue);
    },
    async submitRawOnly(formValue) {
      await dispatch({}, formValue, 'raw');
    },
  };
  return harness;

  async function dispatch(
    payload: Record<string, unknown>,
    formValue?: Record<string, unknown>,
    via: 'action' | 'raw' = 'action',
  ): Promise<void> {
    const token = payload.bridge_token ?? findToken(channel);
    await handleCardAction({
      channel: channel as never,
      evt: {
        action: {
          value: {
            __bridge_hitl: true,
            request_id: question.requestId,
            bridge_token: token,
            ...payload,
          },
          ...(formValue && via === 'action' ? { formValue } : {}),
        },
        ...(formValue && via === 'raw' ? { raw: { action: { form_value: formValue } } } : {}),
        chatId: 'oc_group',
        messageId: 'om_fake_1',
        operator: { openId: 'ou_operator', name: '邵加一' },
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
      humanInput: {
        answer: (_requestId: string, decision: HumanInputAnswer) => {
          answer = decision;
          return true;
        },
      } as never,
      humanInputRenderer: renderer,
    });
    // The repaint is detached from the handler; let it run.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * A real token from the rendered card, since the click's payload has to carry
 * a signature the dispatcher will accept. The action bound into it is per
 * request, so any button's token works.
 */
function findToken(channel: FakeChannel): string {
  const values = buttonValues(renderedCard(channel));
  const token = values.map((value) => value.bridge_token).find((t) => typeof t === 'string');
  if (!token) throw new Error('no signed button on the rendered card');
  return token;
}

function renderedCard(channel: FakeChannel): object {
  const last = channel.sent.at(-1);
  return (last?.content as { card?: object } | undefined)?.card ?? {};
}

/** The card JSON written to the clicked message — what the reader ends up seeing. */
function frozenCards(channel: FakeChannel): object[] {
  return channel.rawClient.requests
    .filter((r) => r.method === 'im.v1.message.patch')
    .map((r) => (r.params as { cardJson: object }).cardJson);
}

function cardAt(cards: object[], index: number): object {
  const card = cards[index];
  if (!card) throw new Error(`no card at index ${index}`);
  return card;
}

function summaryOf(card: object): unknown {
  return (card as { config?: { summary?: { content?: unknown } } }).config?.summary?.content;
}

function buttonLabels(card: object): string[] {
  return nodesOf(card, 'button').map((button) => {
    const text = button.text as { content?: string } | undefined;
    return text?.content ?? '';
  });
}

function nodesOf(card: object, tag: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  walk(card, (node) => {
    if (node.tag === tag) found.push(node);
  });
  return found;
}

function buttonValues(card: object): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  walk(card, (node) => {
    if (node.tag !== 'button' || !Array.isArray(node.behaviors)) return;
    for (const behavior of node.behaviors as Array<Record<string, unknown>>) {
      if (behavior.type === 'callback' && behavior.value) found.push(behavior.value as Record<string, unknown>);
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
