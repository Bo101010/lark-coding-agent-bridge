import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { ChatModeCache } from '../bot/chat-mode-cache';
import type { PendingQueue } from '../bot/pending-queue';
import type { ProcessPool } from '../bot/process-pool';
import type { CallbackAuth } from './callback-auth';
import { runCommandHandler, type CommandContext, type Controls } from '../commands';
import { log } from '../core/logger';
import { canUseDm, canUseGroup } from '../policy/access';
import type { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { commandSessionCatalogIdentity } from '../bot/session-catalog-identity';
import { lookupMessageThreadId } from '../bot/thread-id';
import type { HumanInputBroker } from '../agent/human-input/broker';
import type { CanUseToolRequest } from '../agent/human-input/types';
import { HUMAN_INPUT_MARKER } from './permission-card';
import { toolDecisionFor, type PermissionChoice } from './permission-decision';
import { type LarkHumanInputRenderer } from './human-input-renderer';

/** Marker key on a button's value object that flags the cardAction as
 * a callback that should be forwarded back to the agent instead
 * of dispatched to a built-in command handler. The double-underscore
 * sigils make it virtually impossible to collide with normal payload
 * fields the agent might set.
 */
const BRIDGE_CALLBACK_MARKER = '__bridge_cb';
const LEGACY_CLAUDE_CALLBACK_MARKER = '__claude_cb';
export interface CardDispatchDeps {
  channel: LarkChannel;
  evt: CardActionEvent;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: AgentAdapter;
  processPool?: ProcessPool;
  runExecutor?: RunExecutor;
  controls: Controls;
  pending: PendingQueue;
  chatModeCache: ChatModeCache;
  callbackAuth?: CallbackAuth;
  callbackPolicyFingerprint?: string;
  callbackPolicyFingerprintForScope?: (scope: string) => string | undefined;
  /** Routes permission / dialog answers back into the blocked run. */
  humanInput?: HumanInputBroker;
  humanInputRenderer?: LarkHumanInputRenderer;
}

export async function handleCardAction(deps: CardDispatchDeps): Promise<void> {
  const value = deps.evt.action.value;
  if (!value || typeof value !== 'object') return;
  const payload = value as Record<string, unknown>;

  const operatorId = deps.evt.operator.openId;
  const chatId = deps.evt.chatId;

  // CardKit 2.0 form submits drop user-input values from action.value; they
  // arrive on raw.action.form_value. The SDK forwards the raw event when
  // includeRawEvent: true is set on the channel options.
  const raw = (deps.evt as CardActionEvent & { raw?: unknown }).raw as
    | { action?: { form_value?: Record<string, unknown> } }
    | undefined;
  const formValue = raw?.action?.form_value;

  // Resolve the click's session scope. For topic groups we need to know
  // the message's thread_id so the action targets the right topic's
  // session — look up the carrier message (the card lives on it) once.
  // Done before the access check so we know the chat mode (p2p vs group)
  // and can skip the chat allowlist for DMs.
  const { scope, threadId, mode } = await resolveScope(deps);

  const accessDecision =
    mode === 'p2p'
      ? canUseDm(deps.controls.profileConfig, deps.controls, operatorId)
      : canUseGroup(deps.controls.profileConfig, deps.controls, chatId, operatorId);
  if (!accessDecision.ok) {
    log.info('cardAction', 'skip-not-allowed-user', {
      operator: operatorId.slice(-6),
      reason: accessDecision.reason,
    });
    return;
  }

  if (LEGACY_CLAUDE_CALLBACK_MARKER in payload) {
    log.info('cardAction', 'skip-legacy-callback-marker', { scope });
    return;
  }

  // Human-in-the-loop answer: the run is blocked mid-turn waiting on this,
  // so it must go straight to the broker (and from there to the CLI's
  // stdin) rather than onto the pending queue as a follow-up message.
  if (HUMAN_INPUT_MARKER in payload) {
    await handleHumanInputAnswer(deps, payload, scope);
    return;
  }

  const cmd = typeof payload.cmd === 'string' ? payload.cmd : '';
  if (cmd) {
    if (isSignedBridgeCallback(payload) && !verifyBridgeToken(deps, payload, scope, cmd).ok) {
      return;
    }
    log.info('cardAction', 'cmd', { cmd, scope });
    const msg = makeFakeMsg(deps.evt, threadId);

    const ctx: CommandContext = {
      channel: deps.channel,
      msg,
      scope,
      chatMode: mode,
      sessions: deps.sessions,
      sessionCatalog: deps.sessionCatalog,
      sessionCatalogIdentity: await commandSessionCatalogIdentity({
        msg,
        scope,
        mode,
        workspaces: deps.workspaces,
        controls: deps.controls,
        access: accessDecision,
      }),
      workspaces: deps.workspaces,
      activeRuns: deps.activeRuns,
      agent: deps.agent,
      processPool: deps.processPool,
      runExecutor: deps.runExecutor,
      controls: deps.controls,
      formValue,
      fromCardAction: true,
    };

    const [name, ...rest] = cmd.split('.');
    const sub = rest.join(' ');
    const args = composeArgs(sub, payload);

    try {
      const ok = await runCommandHandler(name ?? '', args, ctx);
      if (!ok) log.warn('cardAction', 'unknown', { cmd });
    } catch (err) {
      log.fail('cardAction', err, { cmd });
    }
    return;
  }

  // Agent-driven callback: the button was rendered by an agent via lark-cli,
  // with `__bridge_cb` set on the value. Forward the click back into the
  // scope's pending queue so the agent resumes its session and sees the click
  // as a follow-up message, with full context of what it sent.
  if (BRIDGE_CALLBACK_MARKER in payload) {
    if (!verifyBridgeToken(deps, payload, scope, 'agent_callback').ok) return;
    forwardToAgent(deps, payload, formValue, scope, threadId, mode);
    return;
  }

  return;
}

async function resolveScope(
  deps: CardDispatchDeps,
): Promise<{ scope: string; threadId: string | undefined; mode: 'p2p' | 'group' | 'topic' }> {  const chatId = deps.evt.chatId;
  const mode = await deps.chatModeCache.resolve(deps.channel, chatId);
  if (mode !== 'topic') {
    return { scope: chatId, threadId: undefined, mode };
  }
  // Topic group — need the carrier message's thread_id to compose scope.
  // One API call per click; could cache by messageId if it ever becomes hot.
  const threadId = await lookupMessageThreadId(deps.channel, deps.evt.messageId);
  if (!threadId) {
    // Fall back to plain chatId. Better to land in the chat's "default"
    // scope than fail the click silently.
    return { scope: chatId, threadId: undefined, mode };
  }
  return { scope: `${chatId}:${threadId}`, threadId, mode };
}

/**
 * Deliver a human's answer to a question the CLI is blocked on.
 *
 * Unlike an agent-authored callback, this cannot go through the pending
 * queue: the run is parked mid-turn and only a `control_response` on its
 * stdin will release it.
 */
async function handleHumanInputAnswer(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  scope: string,
): Promise<void> {
  const requestId = typeof payload.request_id === 'string' ? payload.request_id : '';
  const choice = payload.choice;
  if (!requestId || !isPermissionChoice(choice)) {
    log.warn('cardAction', 'hitl-malformed', { scope });
    return;
  }

  if (!deps.humanInput) {
    log.warn('cardAction', 'hitl-no-broker', { scope, requestId });
    return;
  }

  // Signed with the same scheme as other bridge callbacks: binds the click
  // to this run, chat, and operator, and the nonce makes it single-use so a
  // card cannot be replayed to approve a second time.
  const auth = verifyBridgeToken(deps, payload, scope, `hitl:${requestId}`);
  if (!auth.ok) {
    // A refused click used to be completely silent, so the card sat there
    // unchanged and the clicker could not tell whether their tap registered.
    // Repaint the reason — but only for a click that actually carried a
    // token, so a payload with no token at all cannot repaint a live card.
    if (hasBridgeToken(payload)) {
      void deps.humanInputRenderer
        ?.notice(requestId, refusalNotice(auth.reason))
        .catch((err: unknown) => {
          log.fail('cardAction', err, { step: 'hitl-refusal-notice', requestId });
        });
    }
    return;
  }

  const pending = deps.humanInputRenderer?.pendingFor(requestId);
  if (!pending) {
    log.info('cardAction', 'hitl-stale', { scope, requestId });
    return;
  }

  const answer =
    pending.kind === 'can_use_tool'
      ? toolDecisionFor(pending.request as CanUseToolRequest, choice)
      : dialogAnswerFor(choice);

  const delivered = deps.humanInput.answer(requestId, answer);
  if (!delivered) {
    log.info('cardAction', 'hitl-already-settled', { scope, requestId });
    return;
  }

  log.info('cardAction', 'hitl-answered', { scope, requestId, choice });
  // Detached on purpose. Lark's client keeps the card locked while this
  // handler is pending and restores its cached copy the moment it returns,
  // discarding a repaint made in the meantime — an answered card would then
  // still look unanswered. The renderer waits out the round trip itself; see
  // its `settleDelayMs`.
  void deps.humanInputRenderer
    ?.settle(requestId, choice, deps.evt.operator.name)
    .catch((err: unknown) => {
      log.fail('cardAction', err, { step: 'hitl-settle', requestId });
    });
}

/**
 * Generic dialog answer. The payload shape is defined per `dialog_kind`;
 * `behavior` is the one field the CLI's dialog settlement understands
 * across kinds.
 */
function dialogAnswerFor(choice: PermissionChoice): Record<string, unknown> {
  return choice === 'deny' ? { behavior: 'cancelled' } : { behavior: 'confirmed' };
}

function isPermissionChoice(value: unknown): value is PermissionChoice {
  return value === 'allow-once' || value === 'allow-always' || value === 'deny';
}

function forwardToAgent(  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  formValue: Record<string, unknown> | undefined,
  scope: string,
  threadId: string | undefined,
  mode: 'p2p' | 'group' | 'topic',
): void {
  // Strip the marker so the agent only sees the meaningful fields it set.
  const {
    [BRIDGE_CALLBACK_MARKER]: _marker,
    bridge_token: _token,
    ...agentPayload
  } = payload;
  const merged = formValue ? { ...agentPayload, form_value: formValue } : agentPayload;
  log.info('cardAction', 'forward-agent', {
    scope,
    payload: JSON.stringify(merged).slice(0, 200),
  });
  const synthetic: NormalizedMessage = {
    messageId: deps.evt.messageId,
    chatId: deps.evt.chatId,
    chatType: mode === 'p2p' ? 'p2p' : 'group',
    threadId,
    senderId: deps.evt.operator.openId,
    senderName: deps.evt.operator.name,
    content: `[card-click] ${JSON.stringify(merged)}`,
    rawContentType: 'card_action',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
  deps.pending.push(scope, synthetic);
}

/**
 * Why a click was refused. `missing-token-or-run` is ours — it covers the
 * cases where there is nothing to verify against; the rest come from
 * `CallbackAuth.verify`.
 */
type CallbackRefusalReason =
  | 'missing-token-or-run'
  | 'malformed'
  | 'unknown-key'
  | 'bad-signature'
  | 'expired'
  | 'context-mismatch'
  | 'nonce-replay'
  | 'nonce-revoked';

type CallbackAuthOutcome = { ok: true } | { ok: false; reason: CallbackRefusalReason };

function verifyBridgeToken(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  scope: string,
  action: string,
): CallbackAuthOutcome {
  const token = typeof payload.bridge_token === 'string' ? payload.bridge_token : '';
  const active = deps.activeRuns.get(scope);
  if (!deps.callbackAuth || !token || !active) {
    log.info('cardAction', 'skip-callback-auth-missing', { scope, action });
    log.warn('callback', 'denied', { scope, action, reason: 'missing-token-or-run' });
    return { ok: false, reason: 'missing-token-or-run' };
  }
  const result = deps.callbackAuth.verify(token, {
    runId: active.run.runId,
    scope,
    chatId: deps.evt.chatId,
    operatorOpenId: deps.evt.operator.openId,
    action,
    policyFingerprint:
      deps.callbackPolicyFingerprintForScope?.(scope) ??
      deps.callbackPolicyFingerprint ??
      '',
  });
  if (!result.ok) {
    log.info('cardAction', 'skip-callback-auth-failed', {
      scope,
      action,
      reason: result.reason,
    });
    log.warn('callback', 'denied', { scope, action, reason: result.reason });
    return { ok: false, reason: result.reason };
  }
  return { ok: true };
}

/**
 * Wording for a click that did not take effect. `context-mismatch` is the
 * one a real user actually hits: the card is bound to whoever started the
 * run, so anyone else in the chat is refused.
 */
function refusalNotice(reason: CallbackRefusalReason): string {
  switch (reason) {
    case 'context-mismatch':
      return '⚠️ 这张卡只能由发起该请求的人操作，这次点击没有生效。';
    case 'expired':
      return '⚠️ 这张卡已经过期，这次点击没有生效。';
    case 'nonce-replay':
    case 'nonce-revoked':
      return '⚠️ 这张卡已经处理过了，这次点击没有生效。';
    case 'missing-token-or-run':
      return '⚠️ 对应的运行已经结束，这张卡不再生效。';
    default:
      return '⚠️ 这次点击没有生效。';
  }
}

function hasBridgeToken(payload: Record<string, unknown>): boolean {
  return typeof payload.bridge_token === 'string' && payload.bridge_token.length > 0;
}

function isSignedBridgeCallback(payload: Record<string, unknown>): boolean {
  return BRIDGE_CALLBACK_MARKER in payload || typeof payload.bridge_token === 'string';
}

/** Turn a button payload like {cmd:'ws.use', name:'proj-a'} into the arg
 * string the text-command handler expects: 'use proj-a'. Accepts `arg`
 * (preferred, generic) or `name` (legacy ws cards). */
function composeArgs(sub: string, payload: Record<string, unknown>): string {
  if (!sub) return '';
  const arg =
    (typeof payload.arg === 'string' && payload.arg) ||
    (typeof payload.name === 'string' && payload.name) ||
    '';
  return arg ? `${sub} ${arg}` : sub;
}

function makeFakeMsg(
  evt: CardActionEvent,
  threadId: string | undefined,
): NormalizedMessage {
  return {
    messageId: evt.messageId,
    chatId: evt.chatId,
    chatType: 'p2p',
    threadId,
    senderId: evt.operator.openId,
    senderName: evt.operator.name,
    content: '',
    rawContentType: 'interactive',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}
