import {
  checkField,
  choiceField,
  otherField,
  type UserQuestion,
} from '../agent/human-input/user-question';
import { card, humanInputValue, settledLead, type PermissionCardOptions } from './permission-card';
import type { PermissionChoice } from './permission-decision';

const LABEL_MAX = 60;
const OTHER_PLACEHOLDER = '其他（直接输入，优先于上面的选择）';

export interface UserQuestionCardOptions extends PermissionCardOptions {
  questions: readonly UserQuestion[];
}

/**
 * Card for a tool whose approval prompt is really a question.
 *
 * `AskUserQuestion` arrives as a `can_use_tool` ask, but the CLI marks it
 * `requires_user_interaction` — its protocol documentation is explicit that
 * one-tap Approve/Deny must not be offered for those, because the card *is*
 * the input surface. So this layout replaces the permission row with the
 * question's own controls: buttons for a lone single-select question, a form
 * for everything else (multi-select, free text, numbers, several questions).
 *
 * The two shapes are not a style preference. A form has to submit as a unit,
 * so it can only answer every question at once; a single single-select
 * question is the common case and deserves one tap rather than
 * open-a-dropdown-then-submit.
 */
export function userQuestionCard(options: UserQuestionCardOptions): object {
  const { questions, settled, notice } = options;
  const title = settledLead(settled, SETTLED_LABELS, '🧑‍⚖️ 需要你的回答');

  const elements: object[] = [{ tag: 'markdown', content: `**${title}**` }];

  if (settled) {
    elements.push(...settledBody(questions, settled.answers, settled.choice, settled.operatorName));
  } else if (isSingleTap(questions)) {
    elements.push(...singleTapBody(options, questions[0]!));
  } else {
    elements.push(...formBody(options, questions));
  }

  if (notice) elements.push({ tag: 'markdown', text_size: 'notation', content: notice });
  return card(elements, title);
}

const SETTLED_LABELS: Record<PermissionChoice, string> = {
  'allow-once': '✅ 已回答',
  'allow-always': '✅ 已回答',
  deny: '⏹ 已跳过',
};

/**
 * A lone single-select question is answered by tapping an option, so it needs
 * no form and no submit button.
 */
function isSingleTap(questions: readonly UserQuestion[]): boolean {
  const only = questions.length === 1 ? questions[0] : undefined;
  return !!only && only.type === 'choice' && !only.multiSelect;
}

function singleTapBody(options: UserQuestionCardOptions, question: UserQuestion): object[] {
  const elements: object[] = [questionBlock(0, question), optionButtons(options, question)];

  // The free-text escape hatch still needs a form: Lark only collects an
  // input's value on submit, and the option buttons above must stay one-tap.
  elements.push({
    tag: 'form',
    name: 'hitl_other_form',
    elements: [
      {
        tag: 'input',
        name: otherField(0),
        placeholder: { tag: 'plain_text', content: OTHER_PLACEHOLDER },
        input_type: 'text',
      },
      submitRow(options, '提交其他答案'),
    ],
  });
  return elements;
}

function optionButtons(options: UserQuestionCardOptions, question: UserQuestion): object {
  return {
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: question.options.map((option) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: truncate(option.label, LABEL_MAX) },
          type: 'primary',
          width: 'fill',
          // Answering straight away: the whole answers record is known from
          // this one tap, so it rides in the callback value.
          behaviors: [
            {
              type: 'callback',
              value: humanInputValue(options, {
                answers: { [question.question]: option.label },
              }),
            },
          ],
        },
      ],
    })),
  };
}

function formBody(options: UserQuestionCardOptions, questions: readonly UserQuestion[]): object[] {
  const elements: object[] = [];
  questions.forEach((question, index) => {
    elements.push(questionBlock(index, question));
    elements.push(...controlFor(question, index));
  });
  elements.push(submitRow(options, '提交'));
  return [{ tag: 'form', name: 'hitl_form', elements }];
}

function questionBlock(index: number, question: UserQuestion): object {
  const lines = [`**${index + 1}. ${escapeMd(question.header)}**`, escapeMd(question.question)];
  const descriptions = question.options
    .filter((option) => option.description || option.preview)
    .map((option) => {
      // The CLI offers `preview` as an HTML fragment for its own renderer. A
      // Lark card cannot render HTML, and dropping it would silently lose
      // something the model took the trouble to write, so the text of it is
      // shown instead — flattened, tags stripped.
      const detail = [option.description, option.preview ? htmlText(option.preview) : '']
        .filter(Boolean)
        .join(' — ');
      return `- \`${escapeCode(truncate(option.label, LABEL_MAX))}\`：${escapeMd(detail)}`;
    });
  if (descriptions.length > 0) lines.push('', ...descriptions);
  if (question.type === 'number' && (question.min !== undefined || question.max !== undefined)) {
    const range = [question.min ?? '不限', question.max ?? '不限'].join(' ~ ');
    lines.push('', `_范围 ${range}${question.step !== undefined ? `，步长 ${question.step}` : ''}_`);
  }
  return { tag: 'markdown', content: lines.join('\n') };
}

/** Flatten an HTML fragment to a single line of text. */
function htmlText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The control for one question, plus its free-text escape hatch.
 *
 * `select_static` and `multi_select_static` are the two form controls Lark
 * validated for us; `checker` has no group form, so a multi-select is one
 * checkbox per option (see {@link checkField}).
 */
function controlFor(question: UserQuestion, index: number): object[] {
  if (question.type === 'text' || question.type === 'number') {
    return [
      {
        tag: 'input',
        name: choiceField(index),
        placeholder: {
          tag: 'plain_text',
          content: question.placeholder ?? (question.type === 'number' ? '输入一个数字' : '输入你的回答'),
        },
        // A free-text answer is usually a sentence or two, so it gets the
        // taller box. `number` is not a valid `input_type` here — the tenant
        // API rejects it outright — so numbers share the plain text box and
        // the range is stated in the question block instead.
        input_type: question.type === 'text' ? 'multiline_text' : 'text',
      },
    ];
  }

  if (question.multiSelect) {
    return [
      {
        tag: 'column_set',
        flex_mode: 'flow',
        horizontal_spacing: 'small',
        columns: question.options.map((option, optionIndex) => ({
          tag: 'column',
          width: 'auto',
          elements: [
            {
              tag: 'checker',
              name: checkField(index, optionIndex),
              text: { tag: 'plain_text', content: truncate(option.label, LABEL_MAX) },
              checked: false,
            },
          ],
        })),
      },
      otherInput(index),
    ];
  }

  return [
    {
      tag: 'select_static',
      name: choiceField(index),
      placeholder: { tag: 'plain_text', content: '请选择' },
      options: question.options.map((option) => ({
        text: { tag: 'plain_text', content: truncate(option.label, LABEL_MAX) },
        value: option.label,
      })),
    },
    otherInput(index),
  ];
}

function otherInput(index: number): object {
  return {
    tag: 'input',
    name: otherField(index),
    placeholder: { tag: 'plain_text', content: OTHER_PLACEHOLDER },
    input_type: 'text',
  };
}

/**
 * Submit plus the escape hatch.
 *
 * Without a way to decline, a question the person does not want to answer
 * would wedge the run until `/stop` — the same reason the permission card
 * always offers a refusal.
 */
function submitRow(options: UserQuestionCardOptions, submitLabel: string): object {
  return {
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [
          {
            tag: 'button',
            name: 'submit_btn',
            text: { tag: 'plain_text', content: submitLabel },
            type: 'primary',
            // Submits the enclosing form, so `form_value` arrives alongside
            // the callback and carries every control's value.
            form_action_type: 'submit',
            behaviors: [{ type: 'callback', value: humanInputValue(options, {}) }],
          },
        ],
      },
      {
        tag: 'column',
        width: 'auto',
        elements: [
          {
            tag: 'button',
            name: 'skip_btn',
            text: { tag: 'plain_text', content: '跳过' },
            behaviors: [{ type: 'callback', value: humanInputValue(options, { choice: 'deny' }) }],
          },
        ],
      },
    ],
  };
}

/**
 * The frozen card: the questions with the answers that were given.
 *
 * Rendered as prose rather than a greyed-out form — a form would need every
 * control re-created and disabled to say the same thing less clearly, and the
 * point of the frozen card is to be the chat's record of the decision.
 */
function settledBody(
  questions: readonly UserQuestion[],
  answers: Record<string, string> | undefined,
  choice: string,
  operatorName: string | undefined,
): object[] {
  const lines: string[] = [];
  for (const question of questions) {
    const answer = answers?.[question.question];
    const shown = answer
      ? `\`${escapeCode(truncate(answer, 200))}\``
      : choice === 'withdrawn'
        ? '_已撤回_'
        : '_未回答_';
    // Keyed by the question text, the same string the answer is filed under —
    // the header is a chip for the live card and two questions can share one.
    lines.push(`**${escapeMd(question.question)}**：${shown}`);
  }
  if (operatorName) lines.push('', `由 ${escapeMd(operatorName)} 操作`);
  return [{ tag: 'markdown', content: lines.join('\n') }];
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
