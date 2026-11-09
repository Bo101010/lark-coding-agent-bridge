import { describe, expect, it } from 'vitest';
import {
  describeAlwaysChoice,
  toolDecisionFor,
} from '../../../src/card/permission-decision';
import {
  HUMAN_INPUT_MARKER,
  toolPermissionCard,
  dialogFallbackCard,
} from '../../../src/card/permission-card';
import type { CanUseToolRequest, PendingHumanInput } from '../../../src/agent/human-input/types';

describe('permission card', () => {
  it('offers the three choices with signed, single-use callbacks', () => {
    const card = toolPermissionCard({
      pending: toolPending({ command: 'rm -rf build' }),
      signCallback: (action) => `token:${action}`,
    });

    const values = buttonValues(card);
    expect(values.map((v) => v.choice)).toEqual(['allow-once', 'allow-always', 'deny']);
    for (const value of values) {
      expect(value[HUMAN_INPUT_MARKER]).toBe(true);
      expect(value.request_id).toBe('req-1');
      // Signed per request, so a click cannot be replayed onto another one.
      expect(value.bridge_token).toBe('token:hitl:req-1');
    }
  });

  it('shows a Bash command as a shell block rather than raw JSON', () => {
    const card = toolPermissionCard({ pending: toolPending({ command: 'echo hi' }) });
    expect(markdown(card)).toContain('```bash\necho hi\n```');
  });

  it('surfaces the path for file tools', () => {
    const pending = toolPending({ file_path: '/etc/hosts' });
    (pending.request as CanUseToolRequest).tool_name = 'Write';
    expect(markdown(toolPermissionCard({ pending }))).toContain('/etc/hosts');
  });

  it('greys out every button once a choice has been made', () => {
    const card = toolPermissionCard({
      pending: toolPending({ command: 'echo hi' }),
      settled: { choice: 'allow-always', operatorName: '邵加一' },
    });

    // The row stays — dropping it left the card reading like a question
    // still waiting for an answer — but nothing on it is clickable.
    const buttons = buttonNodes(card);
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      expect(button.disabled_tips).toMatchObject({ tag: 'plain_text' });
    }

    const text = markdown(card);
    expect(text).toContain('已始终允许');
    expect(text).toContain('由 邵加一 操作');
    expect(text).toContain('.claude/settings.local.json');
  });

  it('marks which option was chosen and stops the card asking for permission', () => {
    const card = toolPermissionCard({
      pending: toolPending({ command: 'echo hi' }),
      settled: { choice: 'deny', operatorName: '邵加一' },
    });

    // The chosen button is relabelled in the past tense, so a greyed row
    // still says which way the decision went.
    expect(buttonLabels(card)).toEqual(['✅ 允许一次', '♾️ 始终允许', '🚫 已拒绝']);
    // A settled card must not keep announcing itself as awaiting an answer.
    expect(markdown(card)).not.toContain('需要你的许可');
    expect(summary(card)).toBe('🚫 已拒绝');
  });

  it('explains a refused click without closing the question', () => {
    const card = toolPermissionCard({
      pending: toolPending({ command: 'echo hi' }),
      notice: '⚠️ 这张卡只能由发起该请求的人操作，这次点击没有生效。',
    });

    expect(markdown(card)).toContain('这次点击没有生效');
    // Still answerable: the person the card is bound to can still click.
    for (const button of buttonNodes(card)) expect(button.disabled).toBeUndefined();
    expect(summary(card)).toBe('🔐 需要你的许可');
  });

  it('drops the always button when persistence would break the tool', () => {
    const card = toolPermissionCard({
      pending: toolPending({ command: 'echo hi' }),
      suppressAlways: true,
    });

    // Two choices, not three: without a suggestion to echo, "always" would
    // synthesize a saved allow-rule, and permanently allowing a tool whose job
    // is to ask leaves nobody to answer it.
    expect(buttonValues(card).map((v) => v.choice)).toEqual(['allow-once', 'deny']);
    const text = markdown(card);
    expect(text).not.toContain('始终允许');
    expect(text).not.toContain('settings.local.json');
    // The card still has to say what it is waiting for.
    expect(text).toContain('运行会一直等待');
  });

  it('renames the always button when the CLI only offers a session switch', () => {
    // Exactly what the CLI suggests for a Write in `default` mode: a
    // session-scoped mode change, not a saved rule. Promising "始终" here
    // would describe an effect the answer does not have.
    const card = toolPermissionCard({ pending: sessionScopedWrite() });

    expect(buttonLabels(card)).toContain('📌 本次会话允许');
    const text = markdown(card);
    expect(text).toContain('不会写入任何配置文件');
    expect(text).not.toContain('settings.local.json');
  });

  it('keeps the always label when the CLI suggests a saved rule', () => {
    const card = toolPermissionCard({
      pending: toolPendingWith([
        { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' },
      ]),
    });

    expect(buttonLabels(card)).toContain('♾️ 始终允许');
    expect(markdown(card)).toContain('.claude/settings.local.json');
  });

  it('freezes a session-scoped answer as session-scoped', () => {
    const card = toolPermissionCard({
      pending: sessionScopedWrite(),
      settled: { choice: 'allow-always', operatorName: '邵加一' },
    });

    const text = markdown(card);
    expect(text).toContain('已允许（本次会话）');
    expect(text).toContain('未写入配置文件');
    expect(text).not.toContain('规则已写入');
    expect(buttonLabels(card)).toContain('📌 已允许（本次会话）');
  });

  it('marks a withdrawn request as needing no action', () => {
    const card = toolPermissionCard({
      pending: toolPending({ command: 'echo hi' }),
      settled: { choice: 'withdrawn' },
    });
    expect(markdown(card)).toContain('已被撤回');
    expect(summary(card)).toBe('⏹ 已撤回');
    // Withdrawal is not an answer, so no option is shown as chosen.
    expect(buttonLabels(card)).toEqual(['✅ 允许一次', '♾️ 始终允许', '🚫 拒绝']);
    for (const button of buttonNodes(card)) expect(button.disabled).toBe(true);
  });

  it('renders an unknown dialog payload for a human to judge', () => {
    const pending: PendingHumanInput = {
      requestId: 'req-2',
      runId: 'run-1',
      scope: 'oc_x',
      kind: 'dialog:repository_trust',
      request: {
        subtype: 'request_user_dialog',
        dialog_kind: 'repository_trust',
        payload: { repo: 'github.com/acme/app' },
      },
      askedAt: Date.now(),
    };

    const card = dialogFallbackCard({ pending });
    expect(markdown(card)).toContain('github.com/acme/app');
    expect(buttonValues(card).map((v) => v.choice)).toEqual(['allow-once', 'deny']);
  });
});

describe('toolDecisionFor', () => {
  it('allows once without touching saved permissions', () => {
    expect(toolDecisionFor(request(), 'allow-once')).toEqual({ behavior: 'allow' });
  });

  it('denies with a message the agent can read', () => {
    const decision = toolDecisionFor(request(), 'deny');
    expect(decision).toMatchObject({ behavior: 'deny' });
    expect((decision as { message: string }).message).toContain('拒绝');
  });

  it('prefers the CLI own permission suggestion for "always allow"', () => {
    const suggestion = {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'echo *' }],
      behavior: 'allow',
      destination: 'localSettings',
    };
    const decision = toolDecisionFor(
      { ...request(), permission_suggestions: [suggestion] },
      'allow-always',
    );

    // Echoing the CLI's own suggestion keeps its rule grammar authoritative.
    expect(decision).toEqual({ behavior: 'allow', updatedPermissions: [suggestion] });
  });

  it('falls back to a tool-scoped localSettings rule when none is suggested', () => {
    const decision = toolDecisionFor(request(), 'allow-always') as {
      behavior: string;
      updatedPermissions: Array<Record<string, unknown>>;
    };

    expect(decision.behavior).toBe('allow');
    // destination localSettings is what lands the rule in the project's
    // .claude/settings.local.json — written by the CLI, not by the bridge.
    expect(decision.updatedPermissions[0]).toMatchObject({
      type: 'addRules',
      behavior: 'allow',
      destination: 'localSettings',
      rules: [{ toolName: 'Bash' }],
    });
  });
});

describe('describeAlwaysChoice', () => {
  // The label is a promise about the answer's effect. If these two ever drift,
  // the card starts lying about what the click will do — which is the whole
  // reason the label is derived rather than hardcoded.
  it('agrees with the payload toolDecisionFor actually sends', () => {
    const requests: CanUseToolRequest[] = [
      request(),
      withSuggestions([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]),
      withSuggestions([{ type: 'addRules', behavior: 'allow', destination: 'localSettings' }]),
      withSuggestions([{ type: 'addRules', behavior: 'allow', destination: 'userSettings' }]),
      withSuggestions([{ type: 'addRules', behavior: 'allow', destination: 'projectSettings' }]),
    ];

    for (const req of requests) {
      const decision = toolDecisionFor(req, 'allow-always') as {
        updatedPermissions: Array<Record<string, unknown>>;
      };
      const persisted = decision.updatedPermissions.some(
        (update) => typeof update.destination === 'string' && update.destination !== 'session',
      );

      const described = describeAlwaysChoice(req);
      expect(described.label).toBe(persisted ? '♾️ 始终允许' : '📌 本次会话允许');
      expect(described.settledNote.includes('未写入配置文件')).toBe(!persisted);
    }
  });

  it('names the settings file a saved rule will land in', () => {
    const choice = describeAlwaysChoice(
      withSuggestions([{ type: 'addRules', behavior: 'allow', destination: 'userSettings' }]),
    );
    expect(choice.hint).toContain('~/.claude/settings.json');
  });

  it('stays vague rather than guessing at an unknown destination', () => {
    const choice = describeAlwaysChoice(
      withSuggestions([{ type: 'addRules', behavior: 'allow', destination: 'somewhereNew' }]),
    );
    expect(choice.name).toBe('始终允许');
    expect(choice.hint).not.toContain('settings');
  });
});

function withSuggestions(suggestions: unknown[]): CanUseToolRequest {
  return { ...request(), permission_suggestions: suggestions };
}

function request(): CanUseToolRequest {
  return {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    tool_use_id: 'toolu_1',
    input: { command: 'echo hi' },
  };
}

function toolPending(input: Record<string, unknown>): PendingHumanInput {
  return {
    requestId: 'req-1',
    runId: 'run-1',
    scope: 'oc_x',
    kind: 'can_use_tool',
    request: { ...request(), input },
    askedAt: Date.now(),
  };
}

function toolPendingWith(suggestions: unknown[]): PendingHumanInput {
  return {
    ...toolPending({ file_path: '/tmp/x.txt' }),
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Write',
      permission_suggestions: suggestions,
    },
  };
}

/** The shape the CLI sends for a Write: a session mode switch, nothing saved. */
function sessionScopedWrite(): PendingHumanInput {
  return toolPendingWith([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
}

function buttonNodes(card: object): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  walk(card, (node) => {
    if (node.tag === 'button') found.push(node);
  });
  return found;
}

function summary(card: object): unknown {
  const config = (card as { config?: { summary?: { content?: unknown } } }).config;
  return config?.summary?.content;
}

function buttonLabels(card: object): string[] {
  const labels: string[] = [];
  walk(card, (node) => {
    if (node.tag === 'button') {
      const text = node.text as Record<string, unknown> | undefined;
      if (typeof text?.content === 'string') labels.push(text.content);
    }
  });
  return labels;
}

function buttonValues(card: object): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  walk(card, (node) => {
    if (node.tag === 'button' && Array.isArray(node.behaviors)) {
      for (const behavior of node.behaviors as Array<Record<string, unknown>>) {
        if (behavior.type === 'callback' && behavior.value) {
          found.push(behavior.value as Record<string, unknown>);
        }
      }
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
