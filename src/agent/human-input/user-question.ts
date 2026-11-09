import type { CanUseToolRequest, ToolPermissionDecision } from './types';

/**
 * The tool whose approval prompt is really a question for the human.
 *
 * Claude Code's `AskUserQuestion` is not a permission gate: the CLI marks the
 * ask `requires_user_interaction`, which its own protocol documentation
 * defines as "one-tap Approve/Deny must not be offered: the tool's approval
 * card IS the user-interaction surface". So the host is expected to render
 * the question — options, multi-select, free text — and answer *on the card*.
 * The answer rides back in the `can_use_tool` response, not as a second
 * round trip.
 */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/** One selectable answer. `preview` is an HTML fragment the CLI can render. */
export interface UserQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

/**
 * One question, as the CLI describes it.
 *
 * `type` selects the control: `choice` (the default when omitted) picks from
 * `options`, `text` is an open-ended box, `number` is a slider/stepper. The
 * CLI documents 2-4 options for a choice question and says it supplies its own
 * free-text escape hatch — we render an explicit 「其他」 box instead, so the
 * affordance is visible rather than implied.
 */
export interface UserQuestion {
  question: string;
  header: string;
  options: UserQuestionOption[];
  multiSelect: boolean;
  type: 'choice' | 'text' | 'number';
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
}

/**
 * Parse an `AskUserQuestion` tool input into questions we can render.
 *
 * Returns `undefined` when the input is not a shape we understand. Callers
 * must then fall back to the ordinary permission card: a question we cannot
 * render is still a tool call the human can allow or deny, and guessing at a
 * payload the protocol transports opaquely is how a card ends up lying.
 */
export function parseUserQuestions(request: CanUseToolRequest): UserQuestion[] | undefined {
  if (request.tool_name !== ASK_USER_QUESTION_TOOL) return undefined;
  const raw = request.input?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const questions: UserQuestion[] = [];
  for (const entry of raw) {
    const question = parseQuestion(entry);
    if (!question) return undefined;
    questions.push(question);
  }
  return questions;
}

function parseQuestion(entry: unknown): UserQuestion | undefined {
  if (!isRecord(entry)) return undefined;
  const text = asString(entry.question);
  const header = asString(entry.header);
  if (!text || !header) return undefined;

  const type = entry.type === 'text' || entry.type === 'number' ? entry.type : 'choice';
  const multiSelect = entry.multiSelect === true;

  if (type !== 'choice') {
    return {
      question: text,
      header,
      options: [],
      multiSelect: false,
      type,
      ...(asString(entry.placeholder) ? { placeholder: asString(entry.placeholder)! } : {}),
      ...(asNumber(entry.min) !== undefined ? { min: asNumber(entry.min)! } : {}),
      ...(asNumber(entry.max) !== undefined ? { max: asNumber(entry.max)! } : {}),
      ...(asNumber(entry.step) !== undefined ? { step: asNumber(entry.step)! } : {}),
    };
  }

  const options = parseOptions(entry.options);
  if (!options) return undefined;
  return { question: text, header, options, multiSelect, type: 'choice' };
}

function parseOptions(raw: unknown): UserQuestionOption[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const options: UserQuestionOption[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return undefined;
    const label = asString(entry.label);
    if (!label) return undefined;
    const description = asString(entry.description);
    const preview = asString(entry.preview);
    options.push({
      label,
      ...(description ? { description } : {}),
      ...(preview ? { preview } : {}),
    });
  }
  return options;
}

/**
 * Field names the card writes and {@link buildAnswers} reads.
 *
 * Positional, so no question text has to survive a round trip through Lark's
 * field-name rules — and so a question containing `"` or `{` cannot break the
 * form. The card and this module are the only two places that know the scheme.
 */
export const choiceField = (index: number): string => `q${index}`;
export const otherField = (index: number): string => `q${index}_other`;
/** One checkbox per option, for a multi-select question. */
export const checkField = (index: number, option: number): string => `q${index}_opt${option}`;

/**
 * The `answers` record the CLI reads back, keyed by question text.
 *
 * Encoding was established against the installed CLI (2.1.289): a
 * multi-select answer is its labels joined with `, `, and a free-text answer
 * is the typed string. A question left unanswered is omitted rather than sent
 * empty — the CLI's own dialog allows leaving a question blank, and an empty
 * string would read as a deliberate empty answer.
 */
export function buildAnswers(
  questions: readonly UserQuestion[],
  submitted: Record<string, unknown>,
): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((question, index) => {
    const other = asText(submitted[otherField(index)]);

    // A multi-select arrives as one checkbox per option (Lark's `checker` has
    // no group form, so each option is its own control); a single-select is
    // one dropdown or button row, which is why the two read differently.
    const selected = question.multiSelect
      ? question.options
          .filter((_, option) => submitted[checkField(index, option)] === true)
          .map((option) => option.label)
      : asTextList(submitted[choiceField(index)]);

    // Free text wins outright for a single answer — the person went out of
    // their way to type something, which is a stronger signal than a default
    // selection. For a multi-select it is one more entry in the list.
    const value = question.multiSelect
      ? [...selected, ...(other ? [other] : [])].join(', ')
      : other || selected.join(', ');

    if (value) answers[question.question] = value;
  });
  return answers;
}

/**
 * The decision for a question answered on the card.
 *
 * `updatedInput` has to be the tool's *complete* input, not just the answers:
 * the CLI validates it against the tool's own schema and rejects the call
 * outright ("The required parameter `questions` is missing") otherwise. The
 * `answers` field is a record, and anything else fails validation too.
 */
export function questionDecision(
  request: CanUseToolRequest,
  answers: Record<string, string>,
): ToolPermissionDecision {
  return { behavior: 'allow', updatedInput: { ...request.input, answers } };
}

/** The decision for a question the human declined to answer. */
export function questionDeclinedDecision(): ToolPermissionDecision {
  return { behavior: 'deny', message: '用户在飞书卡片上跳过了这个问题。' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Form controls disagree about how they hand back a selection: a dropdown
 * gives a string, a multi-select an array. Normalize both, dropping blanks.
 */
function asTextList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean);
  const single = asText(value);
  return single ? [single] : [];
}
