import type { CanUseToolRequest, PendingHumanInput, RequestUserDialogRequest } from '../agent/human-input/types';
import { describeAlwaysChoice, type AlwaysChoice, type PermissionChoice } from './permission-decision';

/**
 * Marker distinguishing a human-in-the-loop answer from an agent-authored
 * callback (`__bridge_cb`). Those are forwarded to the pending queue as a
 * follow-up message; these must reach the *live* run's stdin instead,
 * because the run is blocked mid-turn waiting for the reply.
 */
export const HUMAN_INPUT_MARKER = '__bridge_hitl';

const INPUT_FIELD_MAX = 400;
const BODY_TOTAL_MAX = 2000;

/**
 * How a human-in-the-loop card ended.
 *
 * A permission card ends in one of the three choices; a question card ends
 * with the answers themselves, which the frozen card replays so the chat
 * keeps a readable record of what was decided.
 */
export interface SettledState {
  choice: PermissionChoice | 'withdrawn' | 'answered';
  /** Present when `choice` is `'answered'`. */
  answers?: Record<string, string>;
  operatorName?: string;
}

export interface PermissionCardOptions {
  pending: PendingHumanInput;
  /** Signs the click so a replayed or forged callback cannot answer. */
  signCallback?: (action: string) => string;
  /** True once a choice has been made — renders a frozen, greyed-out card. */
  settled?: SettledState;
  /**
   * One-off line explaining a click that was refused, e.g. by someone other
   * than the person who started the run. The question is still open, so the
   * card keeps its live buttons.
   */
  notice?: string;
  /**
   * Drop the 「始终允许」 button.
   *
   * Set for a `requires_user_interaction` ask whose payload we could not
   * render as a question card. The CLI's contract forbids a one-tap decision
   * there, and "always" is worse than forbidden: with no
   * `permission_suggestions` to echo we would synthesize an allow-rule for
   * the tool, and permanently allowing `AskUserQuestion` breaks it — the tool
   * exists to ask, and an auto-allowed call has nobody to answer it.
   */
  suppressAlways?: boolean;
}

/**
 * Card asking a human to approve one tool call.
 *
 * Offers the three choices the product calls for: 允许一次 / 始终允许 / 拒绝.
 *
 * The third label is not fixed: "always" is answered with the CLI's own
 * `permission_suggestions`, and for a `Write` that suggestion is a
 * session-scoped mode switch rather than a saved rule. Labelling that
 * 「始终允许」 would promise persistence the answer does not deliver, so the
 * label and its footnote are both derived from the payload we are about to
 * send — see `describeAlwaysChoice`.
 *
 * A settled card keeps its button row, greyed out and inert, with the chosen
 * option relabelled: dropping the row entirely left the card looking like a
 * question still waiting to be answered.
 */
export function toolPermissionCard(options: PermissionCardOptions): object {
  const { pending, settled, notice } = options;
  const request = pending.request as CanUseToolRequest;
  const always = describeAlwaysChoice(request);

  const settledLabels: Record<PermissionChoice, string> = {
    'allow-once': '✅ 已允许一次',
    'allow-always': always.settledLead,
    deny: '🚫 已拒绝',
  };
  const labelFor = (choice: PermissionChoice, open: string): string =>
    settled?.choice === choice ? settledLabels[choice] : open;

  const title = settledLead(settled, settledLabels, '🔐 需要你的许可');

  const elements: object[] = [
    {
      tag: 'markdown',
      content: [`**${title}**`, '', `**工具**：\`${escapeCode(request.tool_name)}\``].join('\n'),
    },
  ];

  const detail = renderToolInput(request);
  if (detail) elements.push({ tag: 'markdown', content: detail });

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: [
      choiceColumn(options, 'allow-once', labelFor('allow-once', '✅ 允许一次'), 'primary'),
      ...(options.suppressAlways
        ? []
        : [choiceColumn(options, 'allow-always', labelFor('allow-always', always.label), 'default')]),
      choiceColumn(options, 'deny', labelFor('deny', '🚫 拒绝'), 'danger'),
    ],
  });

  const footnote = settled
    ? settledDetail(settled, always)
    : [
        options.suppressAlways ? '' : `「${always.name}」${always.hint}`,
        '运行会一直等待，直到你做出选择或发送 `/stop`。',
      ]
        .filter(Boolean)
        .join('');
  if (footnote) elements.push({ tag: 'markdown', text_size: 'notation', content: footnote });
  if (notice) elements.push({ tag: 'markdown', text_size: 'notation', content: notice });

  return card(elements, title);
}

/**
 * Generic card for a `request_user_dialog` kind we have a renderer for but
 * no bespoke layout. Shows the payload so a human can decide, rather than
 * guessing at a shape the protocol transports opaquely.
 */
export function dialogFallbackCard(options: PermissionCardOptions): object {
  const { pending, settled, notice } = options;
  const request = pending.request as RequestUserDialogRequest;

  const settledLabels: Record<PermissionChoice, string> = {
    'allow-once': '✅ 已确认',
    'allow-always': '✅ 已确认',
    deny: '🚫 已取消',
  };
  const labelFor = (choice: PermissionChoice, open: string): string =>
    settled?.choice === choice ? settledLabels[choice] : open;

  const title = settledLead(settled, settledLabels, '🧑‍⚖️ 需要你的确认');

  const elements: object[] = [
    {
      tag: 'markdown',
      content: [`**${title}**`, '', `**类型**：\`${escapeCode(request.dialog_kind)}\``].join('\n'),
    },
  ];

  const payload = request.payload ? jsonBlock(request.payload) : '';
  if (payload) elements.push({ tag: 'markdown', content: payload });

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: [
      choiceColumn(options, 'allow-once', labelFor('allow-once', '✅ 确认'), 'primary'),
      choiceColumn(options, 'deny', labelFor('deny', '🚫 取消'), 'danger'),
    ],
  });

  const footnote = settled ? settledDetail(settled) : '';
  if (footnote) elements.push({ tag: 'markdown', text_size: 'notation', content: footnote });
  if (notice) elements.push({ tag: 'markdown', text_size: 'notation', content: notice });

  return card(elements, title);
}

/**
 * `title` doubles as the card's chat-list summary, so a settled card is
 * identifiable as settled without opening it.
 *
 * Exported because the question card is a sibling layout that shares the same
 * envelope and the same frozen-card conventions.
 */
export function card(elements: object[], title: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: title } },
    body: { elements },
  };
}

/**
 * The frozen card's headline. An answered question card has no choice to name,
 * so callers that cannot render one pass their own label and this falls back
 * to the open-card title only when nothing was settled at all.
 */
export function settledLead(
  settled: SettledState | undefined,
  labels: Record<PermissionChoice, string>,
  open: string,
): string {
  if (!settled) return open;
  if (settled.choice === 'withdrawn') return '⏹ 已撤回';
  if (settled.choice === 'answered') return '✅ 已回答';
  return labels[settled.choice];
}

/**
 * The callback value a card button carries to answer a parked question.
 *
 * Shared by every layout so the marker, the request id and the signature are
 * produced in exactly one place — a button that forgets the marker would be
 * forwarded to the agent as a follow-up message instead of released into the
 * blocked run's stdin.
 */
export function humanInputValue(
  options: PermissionCardOptions,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const value: Record<string, unknown> = {
    [HUMAN_INPUT_MARKER]: true,
    request_id: options.pending.requestId,
    ...extra,
  };
  if (options.signCallback) {
    value.bridge_token = options.signCallback(`hitl:${options.pending.requestId}`);
  }
  return value;
}

function choiceColumn(
  options: PermissionCardOptions,
  choice: PermissionChoice,
  label: string,
  style: 'primary' | 'danger' | 'default',
): object {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [choiceButton(options, choice, label, style)],
  };
}

function choiceButton(
  options: PermissionCardOptions,
  choice: PermissionChoice,
  label: string,
  style: 'primary' | 'danger' | 'default',
): object {
  const button: Record<string, unknown> = {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: style,
    width: 'fill',
    behaviors: [{ type: 'callback', value: humanInputValue(options, { choice }) }],
  };

  // A settled card keeps its buttons so it is obvious which question was
  // answered and which option was taken — but they must be inert. `disabled`
  // greys the button and stops it firing; `disabled_tips` says why on hover.
  // Behaviors stay attached as a belt-and-braces fallback: if a client
  // ignores `disabled`, the click still reaches us and gets refused there.
  const settled = options.settled;
  if (settled) {
    button.disabled = true;
    button.disabled_tips = {
      tag: 'plain_text',
      content: settled.choice === choice ? '你选择的就是这一项' : '这张卡已经处理过了',
    };
  }
  return button;
}

/**
 * Who answered, and what the answer actually did. The "always" note is
 * carried over from `describeAlwaysChoice` so the settled card repeats the
 * same promise the buttons made.
 *
 * `always` is absent only on the dialog fallback card, which offers no
 * "always" button — the branch it feeds is therefore unreachable there.
 */
function settledDetail(
  settled: NonNullable<PermissionCardOptions['settled']>,
  always?: AlwaysChoice,
): string {
  if (settled.choice === 'withdrawn') return '该请求已被撤回，无需处理';
  const who = settled.operatorName ? `由 ${escapeMd(settled.operatorName)} 操作` : '';
  const note = settled.choice === 'allow-always' ? (always?.settledNote ?? '') : '';
  return [who, note].filter(Boolean).join(' · ');
}

function renderToolInput(request: CanUseToolRequest): string {
  if (!request.input) return '';

  // Bash is the overwhelmingly common case and reads far better as a shell
  // block than as JSON.
  const command = request.input.command;
  if (request.tool_name === 'Bash' && typeof command === 'string') {
    const parts = [`\`\`\`bash\n${truncate(command, INPUT_FIELD_MAX)}\n\`\`\``];
    const description = request.input.description;
    if (typeof description === 'string' && description.trim()) {
      parts.push(`_${escapeMd(truncate(description, 120))}_`);
    }
    return cap(parts.join('\n'));
  }

  // File tools: the path is what the decision hinges on.
  const filePath = request.input.file_path ?? request.input.path;
  if (typeof filePath === 'string') {
    return cap(`**路径**：\`${escapeCode(truncate(filePath, INPUT_FIELD_MAX))}\``);
  }

  return cap(jsonBlock(request.input));
}

function jsonBlock(value: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
  if (!text || text === '{}') return '';
  return `\`\`\`json\n${truncate(text, INPUT_FIELD_MAX * 2)}\n\`\`\``;
}

function cap(body: string): string {
  return body.length <= BODY_TOTAL_MAX ? body : `${body.slice(0, BODY_TOTAL_MAX)}…`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function escapeMd(s: string): string {
  return s.replace(/([*_~`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, 'ˋ');
}
