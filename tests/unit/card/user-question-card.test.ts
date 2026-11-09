import { describe, expect, it } from 'vitest';
import type { CanUseToolRequest, PendingHumanInput } from '../../../src/agent/human-input/types';
import {
  checkField,
  choiceField,
  otherField,
  parseUserQuestions,
  type UserQuestion,
} from '../../../src/agent/human-input/user-question';
import { HUMAN_INPUT_MARKER } from '../../../src/card/permission-card';
import { userQuestionCard } from '../../../src/card/user-question-card';

describe('question card', () => {
  it('answers a lone single-select question with one tap per option', () => {
    const card = cardFor([choice('用哪个数据库？', 'Postgres', 'SQLite')]);

    // The options are not wrapped in a form: the common case should be one
    // tap, not open-a-dropdown-then-submit. The only form is the free-text
    // escape hatch below them.
    expect(formNames(card)).toEqual(['hitl_other_form']);
    expect(buttonLabels(card)).toEqual(['Postgres', 'SQLite', '提交其他答案', '跳过']);

    const optionValues = buttonValues(card).filter((v) => 'answers' in v);
    expect(optionValues).toEqual([
      { [HUMAN_INPUT_MARKER]: true, request_id: 'req-1', bridge_token: 'tok', answers: { '用哪个数据库？': 'Postgres' } },
      { [HUMAN_INPUT_MARKER]: true, request_id: 'req-1', bridge_token: 'tok', answers: { '用哪个数据库？': 'SQLite' } },
    ]);
  });

  it('still offers a free-text box next to the one-tap options', () => {
    const card = cardFor([choice('用哪个数据库？', 'Postgres', 'SQLite')]);
    // The box needs a form of its own — Lark only collects an input on submit.
    const form = nodes(card, 'form')[0];
    expect(inputNames(form)).toEqual([otherField(0)]);
  });

  it('uses a form when the question is multi-select, one checkbox per option', () => {
    const card = cardFor([
      { question: '要哪些？', header: '依赖', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true, type: 'choice' },
    ]);

    const form = nodes(card, 'form')[0];
    expect(inputNames(form)).toEqual([checkField(0, 0), checkField(0, 1), otherField(0)]);
    expect(nodes(form, 'checker')).toHaveLength(2);
    // `checker` has no group form, so nothing may try to give it options.
    for (const checker of nodes(form, 'checker')) {
      expect(checker.checked).toBe(false);
      expect(checker.options).toBeUndefined();
    }
  });

  it('uses a form for several questions, whatever their types', () => {
    const card = cardFor([
      choice('用哪个？', 'A', 'B'),
      { question: '并发？', header: '并发', options: [], multiSelect: false, type: 'number', min: 1, max: 8 },
    ]);

    const form = nodes(card, 'form')[0];
    expect(inputNames(form)).toEqual([choiceField(0), otherField(0), choiceField(1)]);
    expect(markdown(card)).toContain('1 ~ 8');
  });

  it('sends every question at once when the form is submitted', () => {
    const card = cardFor([
      choice('用哪个？', 'A', 'B'),
      { question: '备注？', header: '备注', options: [], multiSelect: false, type: 'text' },
    ]);

    const submit = buttonValues(card).find((v) => !('choice' in v) && !('answers' in v));
    // Only the request id and the signature: the controls arrive in
    // `form_value`, so the payload must not pretend to carry answers.
    expect(submit).toEqual({ [HUMAN_INPUT_MARKER]: true, request_id: 'req-1', bridge_token: 'tok' });
    const submitButton = nodes(card, 'button').find((b) => b.form_action_type === 'submit');
    expect(submitButton).toBeDefined();
  });

  it('always offers a way out, so a question cannot wedge the run', () => {
    const card = cardFor([choice('用哪个？', 'A', 'B')]);
    const skip = buttonValues(card).find((v) => v.choice === 'deny');
    expect(skip).toEqual({ [HUMAN_INPUT_MARKER]: true, request_id: 'req-1', bridge_token: 'tok', choice: 'deny' });
  });

  it('replays the answers on the frozen card, per question', () => {
    const questions = [choice('用哪个数据库？', 'Postgres', 'SQLite'), choice('要不要迁移？', '要', '不要')];
    const card = userQuestionCard({
      pending: questionPending(questions),
      questions: parse(questions),
      settled: { choice: 'answered', answers: { '用哪个数据库？': 'Postgres', '要不要迁移？': '要' }, operatorName: '邵加一' },
      signCallback: () => 'tok',
    });

    expect(summary(card)).toBe('✅ 已回答');
    const text = markdown(card);
    expect(text).toContain('用哪个数据库？');
    expect(text).toContain('Postgres');
    expect(text).toContain('要不要迁移？');
    expect(text).toContain('由 邵加一 操作');
    // Frozen means inert: no live controls left to click.
    expect(nodes(card, 'form')).toHaveLength(0);
    expect(nodes(card, 'button')).toHaveLength(0);
  });

  it('marks the questions a submit left unanswered', () => {
    const questions = [choice('用哪个？', 'A', 'B'), choice('第二个？', 'C', 'D')];
    const card = userQuestionCard({
      pending: questionPending(questions),
      questions: parse(questions),
      settled: { choice: 'answered', answers: { '用哪个？': 'A' } },
    });
    expect(markdown(card)).toContain('_未回答_');
  });

  it('says a skipped question was skipped, not left blank', () => {
    const questions = [choice('用哪个？', 'A', 'B')];
    const card = userQuestionCard({
      pending: questionPending(questions),
      questions: parse(questions),
      settled: { choice: 'deny', answers: {} },
    });
    expect(summary(card)).toBe('⏹ 已跳过');
    expect(markdown(card)).toContain('_未回答_');
  });

  // Caught live: a helper returning `object[]` pushed without a spread left a
  // nested array in `body.elements`, and the tenant API rejected the whole
  // card with `parse card json err` on that element. Nothing else in the suite
  // noticed, because every other assertion walks recursively.
  it.each([
    ['a single-select question', [choice('用哪个？', 'A', 'B')]],
    ['a multi-select question', [{ question: '要哪些？', header: 'h', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true, type: 'choice' as const }]],
    ['several questions', [choice('用哪个？', 'A', 'B'), choice('还要吗？', '要', '不要')]],
  ])('emits a flat element list for %s', (_name, questions) => {
    const body = (cardFor(questions) as { body: { elements: unknown[] } }).body;
    expect(body.elements.length).toBeGreaterThan(0);
    for (const element of body.elements) {
      expect(Array.isArray(element)).toBe(false);
      expect(element).toMatchObject({ tag: expect.any(String) });
    }
  });

  it('renders the descriptions and header so the choice is informed', () => {
    const card = cardFor([
      {
        question: '用哪个数据库？',
        header: '存储',
        options: [
          { label: 'Postgres', description: '关系型，事务强' },
          { label: 'SQLite', description: '单文件，零运维' },
        ],
        multiSelect: false,
        type: 'choice',
      },
    ]);
    const text = markdown(card);
    expect(text).toContain('**1. 存储**');
    expect(text).toContain('关系型，事务强');
  });

  // The CLI's `preview` is HTML for its own renderer. A Lark card cannot show
  // HTML, but dropping the field would lose whatever the model wrote there.
  it('flattens an HTML preview instead of dropping it', () => {
    const card = cardFor([
      {
        question: '哪个布局？',
        header: '布局',
        options: [
          { label: 'A', description: '紧凑', preview: '<div><b>两栏</b><br/>窄屏会换行</div>' },
          { label: 'B', preview: '&lt;单栏&gt;' },
        ],
        multiSelect: false,
        type: 'choice',
      },
    ]);

    const text = markdown(card);
    expect(text).toContain('紧凑 — 两栏 窄屏会换行');
    expect(text).toContain('<单栏>');
    expect(text).not.toContain('<div>');
    expect(text).not.toContain('<b>');
  });
});

function cardFor(questions: UserQuestion[]): object {
  return userQuestionCard({
    pending: questionPending(questions),
    questions: parse(questions),
    signCallback: () => 'tok',
  });
}

function parse(questions: UserQuestion[]): UserQuestion[] {
  const parsed = parseUserQuestions(questionPending(questions).request as CanUseToolRequest);
  if (!parsed) throw new Error('questions did not parse');
  return parsed;
}

function questionPending(questions: UserQuestion[]): PendingHumanInput {
  return {
    requestId: 'req-1',
    runId: 'run-1',
    scope: 'oc_group',
    kind: 'can_use_tool',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_q',
      requires_user_interaction: true,
      input: { questions },
    },
    askedAt: 1000,
  };
}

function choice(question: string, ...labels: string[]): UserQuestion {
  return {
    question,
    header: 'h',
    options: labels.map((label) => ({ label })),
    multiSelect: false,
    type: 'choice',
  };
}

function summary(card: object): unknown {
  return (card as { config?: { summary?: { content?: unknown } } }).config?.summary?.content;
}

function nodes(card: unknown, tag: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  walk(card, (node) => {
    if (node.tag === tag) found.push(node);
  });
  return found;
}

/** The control names inside a form, in render order. */
function inputNames(form: unknown): string[] {
  const names: string[] = [];
  walk(form, (node) => {
    if (node.tag === 'form' || node.tag === 'button') return;
    if (typeof node.name === 'string') names.push(node.name);
  });
  return names;
}

function formNames(card: object): string[] {
  return nodes(card, 'form').map((form) => String(form.name));
}

function buttonLabels(card: object): string[] {
  return nodes(card, 'button').map((button) => {
    const text = button.text as { content?: string } | undefined;
    return text?.content ?? '';
  });
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

function markdown(card: object): string {
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
