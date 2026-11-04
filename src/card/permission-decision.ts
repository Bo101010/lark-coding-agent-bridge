import type { CanUseToolRequest, ToolPermissionDecision } from '../agent/human-input/types';

/** The three answers a tool-permission card offers. */
export type PermissionChoice = 'allow-once' | 'allow-always' | 'deny';

/**
 * Translate a button choice into the protocol decision for a tool prompt.
 *
 * "始终允许" prefers the CLI's own `permission_suggestions` verbatim: the
 * CLI owns the rule grammar, and echoing its suggestion avoids inventing
 * `ruleContent` that might not match what it would have written. Only when
 * no suggestion is offered do we synthesize a rule, scoped to the tool.
 */
export function toolDecisionFor(
  request: CanUseToolRequest,
  choice: PermissionChoice,
): ToolPermissionDecision {
  if (choice === 'deny') {
    return { behavior: 'deny', message: '用户在飞书卡片上拒绝了这次操作。' };
  }
  if (choice === 'allow-once') {
    return { behavior: 'allow' };
  }
  return { behavior: 'allow', updatedPermissions: alwaysPermissionsFor(request) };
}

/**
 * The `updatedPermissions` an "always" answer carries — the CLI's suggestion
 * when it offered one, otherwise a tool-scoped rule we synthesize.
 *
 * Exported so the card can describe the very same payload it is about to
 * send. A label derived from anything else drifts the moment the CLI changes
 * what it suggests, and a card that misstates its own effect is worse than
 * no explanation at all.
 */
export function alwaysPermissionsFor(request: CanUseToolRequest): unknown[] {
  const suggestions = request.permission_suggestions;
  if (Array.isArray(suggestions) && suggestions.length > 0) return suggestions;
  return [
    {
      type: 'addRules',
      rules: [{ toolName: request.tool_name }],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ];
}

/**
 * How long an "always" answer actually lasts, as the CLI will interpret it.
 *
 * Not a property we choose: for a `Write` the CLI suggests
 * `{type: 'setMode', mode: 'acceptEdits', destination: 'session'}`, so the
 * answer switches this session's mode and persists nothing. Only an
 * `addRules`-style update aimed at a settings file outlives the session.
 */
export interface AlwaysChoice {
  /** Button label, icon included. */
  label: string;
  /** The label without its icon, for prose like 「「始终允许」会…」. */
  name: string;
  /** Explanation rendered under the buttons. */
  hint: string;
  /** Frozen-card lead-in, e.g. 「♾️ 已始终允许」. */
  settledLead: string;
  /** Frozen-card explanation, empty when there is nothing to add. */
  settledNote: string;
}

const SETTINGS_FILES: Record<string, string> = {
  localSettings: '项目里的 `.claude/settings.local.json`',
  projectSettings: '项目里的 `.claude/settings.json`',
  userSettings: '`~/.claude/settings.json`',
};

export function describeAlwaysChoice(request: CanUseToolRequest): AlwaysChoice {
  const destination = alwaysPermissionsFor(request)
    .map(updateDestination)
    .find((d) => d !== undefined && d !== 'session');

  if (destination === undefined) {
    return {
      label: '📌 本次会话允许',
      name: '本次会话允许',
      hint: '只对本会话生效，不会写入任何配置文件。',
      settledLead: '📌 已允许（本次会话）',
      settledNote: '未写入配置文件',
    };
  }

  const where = SETTINGS_FILES[destination];
  return {
    label: '♾️ 始终允许',
    name: '始终允许',
    hint: where ? `会把规则写入${where}。` : '规则会由 Claude Code 保存下来。',
    settledLead: '♾️ 已始终允许',
    settledNote: where ? `规则已写入${where}` : '',
  };
}

function updateDestination(update: unknown): string | undefined {
  if (!update || typeof update !== 'object') return undefined;
  const destination = (update as { destination?: unknown }).destination;
  return typeof destination === 'string' ? destination : undefined;
}
