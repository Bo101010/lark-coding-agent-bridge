import { describe, expect, it } from 'vitest';
import type { CanUseToolRequest } from '../../../src/agent/human-input/types';
import {
  buildAnswers,
  checkField,
  choiceField,
  otherField,
  parseUserQuestions,
  questionDecision,
  questionDeclinedDecision,
} from '../../../src/agent/human-input/user-question';

describe('parseUserQuestions', () => {
  it('reads the questions out of an AskUserQuestion ask', () => {
    const questions = parseUserQuestions(
      ask({
        questions: [
          {
            question: '用哪个数据库？',
            header: '存储',
            options: [
              { label: 'Postgres', description: '关系型，事务强' },
              { label: 'SQLite' },
            ],
            multiSelect: false,
          },
        ],
      }),
    );

    expect(questions).toEqual([
      {
        question: '用哪个数据库？',
        header: '存储',
        multiSelect: false,
        type: 'choice',
        options: [{ label: 'Postgres', description: '关系型，事务强' }, { label: 'SQLite' }],
      },
    ]);
  });

  it('defaults an omitted type to choice', () => {
    const questions = parseUserQuestions(
      ask({ questions: [choice('要不要？', 'A', 'B')] }),
    );
    expect(questions?.[0]?.type).toBe('choice');
  });

  it('keeps the number bounds so the card can show the range', () => {
    const questions = parseUserQuestions(
      ask({
        questions: [
          { question: '并发多少？', header: '并发', type: 'number', min: 1, max: 16, step: 2 },
        ],
      }),
    );
    expect(questions?.[0]).toMatchObject({ type: 'number', min: 1, max: 16, step: 2, options: [] });
  });

  it('carries the placeholder for a text question', () => {
    const questions = parseUserQuestions(
      ask({ questions: [{ question: '备注？', header: '备注', type: 'text', placeholder: '随便写' }] }),
    );
    expect(questions?.[0]).toMatchObject({ type: 'text', placeholder: '随便写' });
  });

  it('ignores every other tool', () => {
    expect(parseUserQuestions({ subtype: 'can_use_tool', tool_name: 'Bash', input: {} })).toBeUndefined();
  });

  // Falling back to the permission card is the whole contract: a payload we do
  // not understand must not be rendered as a question we would then answer
  // wrongly. Every shape below is something the CLI could plausibly emit.
  it.each<[string, CanUseToolRequest]>([
    ['no input at all', ask({})],
    ['questions not an array', ask({ questions: 'nope' })],
    ['questions empty', ask({ questions: [] })],
    ['question text missing', ask({ questions: [{ header: 'h', options: [{ label: 'a' }, { label: 'b' }] }] })],
    ['header missing', ask({ questions: [{ question: 'q?', options: [{ label: 'a' }, { label: 'b' }] }] })],
    ['choice with no options', ask({ questions: [{ question: 'q?', header: 'h' }] })],
    ['option without a label', ask({ questions: [choice('q?', 'a', '')] })],
    ['one bad question among good ones', ask({ questions: [choice('q?', 'a', 'b'), { header: 'h' }] })],
  ])('returns undefined for %s', (_name, request) => {
    expect(parseUserQuestions(request)).toBeUndefined();
  });
});

describe('buildAnswers', () => {
  it('keys the answers by the question text, as the CLI reads them back', () => {
    const questions = parseUserQuestions(ask({ questions: [choice('用哪个数据库？', 'Postgres', 'SQLite')] }))!;
    expect(buildAnswers(questions, { [choiceField(0)]: 'SQLite' })).toEqual({ '用哪个数据库？': 'SQLite' });
  });

  it('joins a multi-select with ", " in option order', () => {
    const questions = parseUserQuestions(
      ask({ questions: [{ question: '要哪些？', header: 'h', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }] }),
    )!;
    // B and C ticked, A not — the order must follow the options, not the ticks.
    const answers = buildAnswers(questions, {
      [checkField(0, 0)]: false,
      [checkField(0, 1)]: true,
      [checkField(0, 2)]: true,
    });
    expect(answers).toEqual({ '要哪些？': 'B, C' });
  });

  it('takes typed text for a text question', () => {
    const questions = parseUserQuestions(ask({ questions: [{ question: '备注？', header: 'h', type: 'text' }] }))!;
    expect(buildAnswers(questions, { [choiceField(0)]: '  随便写写  ' })).toEqual({ '备注？': '随便写写' });
  });

  it('lets the free-text box override the dropdown for a single answer', () => {
    const questions = parseUserQuestions(ask({ questions: [choice('用哪个？', 'Postgres', 'SQLite')] }))!;
    const answers = buildAnswers(questions, {
      [choiceField(0)]: 'Postgres',
      [otherField(0)]: 'DuckDB',
    });
    expect(answers).toEqual({ '用哪个？': 'DuckDB' });
  });

  it('adds the free-text box as one more entry to a multi-select', () => {
    const questions = parseUserQuestions(
      ask({ questions: [{ question: '要哪些？', header: 'h', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] }),
    )!;
    const answers = buildAnswers(questions, {
      [checkField(0, 0)]: true,
      [otherField(0)]: '还要 C',
    });
    expect(answers).toEqual({ '要哪些？': 'A, 还要 C' });
  });

  it('omits an unanswered question rather than sending it empty', () => {
    const questions = parseUserQuestions(
      ask({
        questions: [choice('第一个？', 'A', 'B'), choice('第二个？', 'C', 'D')],
      }),
    )!;
    expect(buildAnswers(questions, { [choiceField(0)]: 'A' })).toEqual({ '第一个？': 'A' });
  });

  it('accepts an array from a control that reports multi-value', () => {
    const questions = parseUserQuestions(ask({ questions: [choice('用哪个？', 'A', 'B')] }))!;
    expect(buildAnswers(questions, { [choiceField(0)]: ['A', 'B'] })).toEqual({ '用哪个？': 'A, B' });
  });

  it('drops blank strings instead of recording them as answers', () => {
    const questions = parseUserQuestions(ask({ questions: [choice('用哪个？', 'A', 'B')] }))!;
    expect(buildAnswers(questions, { [choiceField(0)]: '   ' })).toEqual({});
  });
});

describe('question decisions', () => {
  it('answers with the complete tool input plus the answers record', () => {
    const request = ask({ questions: [choice('用哪个？', 'A', 'B')] });
    const decision = questionDecision(request, { '用哪个？': 'A' });

    expect(decision).toEqual({
      behavior: 'allow',
      // The CLI validates updatedInput against the tool's own schema; a bare
      // `{answers}` fails with "The required parameter `questions` is missing".
      updatedInput: { questions: request.input!.questions, answers: { '用哪个？': 'A' } },
    });
  });

  it('declines as a refusal, so the model hears that a human said no', () => {
    expect(questionDeclinedDecision()).toMatchObject({ behavior: 'deny' });
  });
});

function ask(input: Record<string, unknown>): CanUseToolRequest {
  return {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'toolu_q',
    requires_user_interaction: true,
    input,
  };
}

function choice(question: string, ...labels: string[]): Record<string, unknown> {
  return { question, header: 'h', options: labels.map((label) => ({ label })) };
}
