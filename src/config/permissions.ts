export type AccessMode = 'read-only' | 'workspace' | 'full';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ClaudePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'bypassPermissions';

export interface PermissionConfig {
  defaultAccess: AccessMode;
  maxAccess: AccessMode;
  claude?: {
    /**
     * Pin Claude's own `--permission-mode` instead of deriving it from
     * `defaultAccess`. Only accepted when the mode does not exceed
     * `maxAccess` — see `CLAUDE_PERMISSION_ACCESS`.
     */
    permissionMode?: ClaudePermissionMode;
    /**
     * Ask a human in Lark whenever the agent needs permission, instead of
     * letting the CLI decide on its own.
     *
     * Opt-in because it is a real behavior change: a `workspace` run that
     * used to sail through on `acceptEdits` will instead park on a card and
     * wait — with no deadline — until someone answers or sends `/stop`.
     */
    askHuman?: boolean;
  };
}

export type PermissionSource = 'permissions' | 'sandbox' | 'default';

interface LegacySandboxInput {
  default?: CodexSandboxMode;
  max?: CodexSandboxMode;
  defaultMode?: CodexSandboxMode;
  maxMode?: CodexSandboxMode;
}

export interface NormalizedPermissions {
  permissions: PermissionConfig;
  source: PermissionSource;
}

const ACCESS_ORDER: Record<AccessMode, number> = {
  'read-only': 0,
  workspace: 1,
  full: 2,
};

/** Every accepted `permissions.claude.permissionMode`, weakest first. */
export const CLAUDE_PERMISSION_MODES: readonly ClaudePermissionMode[] = [
  'plan',
  'default',
  'acceptEdits',
  'auto',
  'bypassPermissions',
];

const CLAUDE_PERMISSION_ACCESS: Record<ClaudePermissionMode, AccessMode> = {
  plan: 'read-only',
  default: 'workspace',
  acceptEdits: 'workspace',
  // Classifier-gated automation: `auto` approves well beyond edits — pushes to
  // any branch, PR creation — so it belongs to the `full` tier. Mapping it to
  // `workspace` would hand a workspace profile the ability to push.
  auto: 'full',
  bypassPermissions: 'full',
};

export function normalizePermissions(input: {
  permissions?: Partial<PermissionConfig> | undefined;
  sandbox?: Partial<LegacySandboxInput> | undefined;
}): NormalizedPermissions {
  const hasSandbox = hasLegacySandbox(input.sandbox);
  const base = hasSandbox
    ? normalizeLegacySandboxPermissions(input.sandbox)
    : defaultPermissions();

  if (input.permissions !== undefined) {
    return {
      permissions: normalizeCanonicalPermissions(input.permissions, base),
      source: 'permissions',
    };
  }

  return {
    permissions: base,
    source: hasSandbox ? 'sandbox' : 'default',
  };
}

export function assertAccessPair(
  defaultAccess: AccessMode,
  maxAccess: AccessMode,
  source: PermissionSource | 'sandbox' = 'permissions',
): void {
  if (ACCESS_ORDER[defaultAccess] > ACCESS_ORDER[maxAccess]) {
    const suffix = source === 'sandbox' ? ' from sandbox' : '';
    throw new Error(`permission defaultAccess cannot exceed maxAccess${suffix}`);
  }
}

export function clampAccess(
  defaultAccess: AccessMode,
  profileMax: AccessMode,
  capabilityMax: AccessMode,
): AccessMode {
  const maxAllowed =
    ACCESS_ORDER[profileMax] < ACCESS_ORDER[capabilityMax] ? profileMax : capabilityMax;
  return ACCESS_ORDER[defaultAccess] <= ACCESS_ORDER[maxAllowed] ? defaultAccess : maxAllowed;
}

export function codexSandboxToAccess(mode: CodexSandboxMode): AccessMode {
  switch (mode) {
    case 'read-only':
      return 'read-only';
    case 'workspace-write':
      return 'workspace';
    case 'danger-full-access':
      return 'full';
    default:
      throw new Error('invalid sandbox mode');
  }
}

export function accessToCodexSandbox(access: AccessMode): CodexSandboxMode {
  switch (access) {
    case 'read-only':
      return 'read-only';
    case 'workspace':
      return 'workspace-write';
    case 'full':
      return 'danger-full-access';
  }
}

export function accessToClaudePermissionMode(
  access: AccessMode,
  permissions?: PermissionConfig,
): ClaudePermissionMode {
  const override = permissions?.claude?.permissionMode;
  if (
    override &&
    ACCESS_ORDER[CLAUDE_PERMISSION_ACCESS[override]] <= ACCESS_ORDER[access]
  ) {
    return override;
  }

  return accessToDefaultClaudePermissionMode(access, permissions);
}

/**
 * Raise `access` to the tier implied by a pinned permission mode, when the pin
 * is one this profile is allowed to run.
 *
 * `permissionMode` is validated against `maxAccess` — both at config-load time
 * (`assertClaudePermissionWithinAccess`) and by `/mode` — so it has to be
 * honoured even when `defaultAccess` sits lower. Without this,
 * `defaultAccess: workspace` + `maxAccess: full` + `permissionMode: auto`
 * validates, saves, and then silently runs as `default`, because the
 * `accessToClaudePermissionMode` guard compares against the *derived* access.
 * Pinning is the operator saying "this profile runs at this mode"; `maxAccess`
 * is the budget that authorises it.
 *
 * Pass the already-clamped access (see {@link clampAccess}) so the agent
 * capability ceiling still wins when it is the lower of the two.
 */
export function elevateAccessForClaudePermissionMode(
  access: AccessMode,
  permissions: PermissionConfig | undefined,
  capabilityMax: AccessMode,
): AccessMode {
  const override = permissions?.claude?.permissionMode;
  if (!override || !permissions) {
    return access;
  }

  const maxAllowed =
    ACCESS_ORDER[permissions.maxAccess] < ACCESS_ORDER[capabilityMax]
      ? permissions.maxAccess
      : capabilityMax;
  if (!claudePermissionFitsAccess(override, maxAllowed)) {
    return access;
  }

  const pinned = CLAUDE_PERMISSION_ACCESS[override];
  return ACCESS_ORDER[pinned] > ACCESS_ORDER[access] ? pinned : access;
}

function accessToDefaultClaudePermissionMode(
  access: AccessMode,
  permissions?: PermissionConfig,
): ClaudePermissionMode {
  switch (access) {
    case 'read-only':
      return 'plan';
    case 'workspace':
      // `acceptEdits` auto-approves edits and never prompts. When the
      // profile asks for human-in-the-loop approval, `default` is what
      // actually raises the prompts we forward to Lark as cards.
      return permissions?.claude?.askHuman ? 'default' : 'acceptEdits';
    case 'full':
      return 'bypassPermissions';
  }
}

export function permissionsToLegacySandbox(permissions: PermissionConfig): {
  default: CodexSandboxMode;
  max: CodexSandboxMode;
  defaultMode: CodexSandboxMode;
  maxMode: CodexSandboxMode;
} {
  const defaultMode = accessToCodexSandbox(permissions.defaultAccess);
  const maxMode = accessToCodexSandbox(permissions.maxAccess);
  return {
    default: defaultMode,
    max: maxMode,
    defaultMode,
    maxMode,
  };
}

function normalizeCanonicalPermissions(
  input: Partial<PermissionConfig>,
  base: PermissionConfig,
): PermissionConfig {
  if (!isConfigObject(input)) {
    throw new Error('invalid permission config');
  }

  const explicitMaxAccess = readAccess(input.maxAccess, 'maxAccess');
  const explicitDefaultAccess = readAccess(input.defaultAccess, 'defaultAccess');
  const maxAccess = explicitMaxAccess ?? base.maxAccess;
  const defaultAccess =
    explicitDefaultAccess ??
    (ACCESS_ORDER[base.defaultAccess] <= ACCESS_ORDER[maxAccess] ? base.defaultAccess : maxAccess);
  assertAccessPair(defaultAccess, maxAccess);

  const claude = normalizeClaudePermissions(input.claude);
  if (claude?.permissionMode) {
    assertClaudePermissionWithinAccess(claude.permissionMode, maxAccess);
  }
  return {
    defaultAccess,
    maxAccess,
    ...(claude ? { claude } : {}),
  };
}

function defaultPermissions(): PermissionConfig {
  return {
    defaultAccess: 'full',
    maxAccess: 'full',
  };
}

function assertClaudePermissionWithinAccess(
  permissionMode: ClaudePermissionMode,
  maxAccess: AccessMode,
): void {
  if (!claudePermissionFitsAccess(permissionMode, maxAccess)) {
    throw new Error('permission claude.permissionMode cannot exceed maxAccess');
  }
}

/** True iff `mode` is allowed to be pinned under `maxAccess`. */
export function claudePermissionFitsAccess(
  mode: ClaudePermissionMode,
  maxAccess: AccessMode,
): boolean {
  return ACCESS_ORDER[CLAUDE_PERMISSION_ACCESS[mode]] <= ACCESS_ORDER[maxAccess];
}

function normalizeLegacySandboxPermissions(
  input: Partial<LegacySandboxInput> | undefined,
): PermissionConfig {
  if (!isConfigObject(input)) {
    throw new Error('invalid sandbox mode');
  }

  const maxMode = readSandboxMode(input.max ?? input.maxMode, 'maxMode') ?? 'danger-full-access';
  const defaultMode = readSandboxMode(input.default ?? input.defaultMode, 'defaultMode') ?? maxMode;
  const defaultAccess = codexSandboxToAccess(defaultMode);
  const maxAccess = codexSandboxToAccess(maxMode);
  assertAccessPair(defaultAccess, maxAccess, 'sandbox');

  return {
    defaultAccess,
    maxAccess,
  };
}

function normalizeClaudePermissions(
  input: PermissionConfig['claude'] | undefined,
): PermissionConfig['claude'] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!isConfigObject(input)) {
    throw new Error('invalid permission claude config');
  }
  const askHuman = readAskHuman(input.askHuman);
  if (input.permissionMode === undefined) {
    return askHuman === undefined ? undefined : { askHuman };
  }
  if (!isClaudePermissionMode(input.permissionMode)) {
    throw new Error('invalid permission claude.permissionMode');
  }
  return {
    permissionMode: input.permissionMode,
    ...(askHuman === undefined ? {} : { askHuman }),
  };
}

function readAskHuman(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error('invalid permission claude.askHuman');
  }
  return value;
}

function hasLegacySandbox(input: Partial<LegacySandboxInput> | undefined): boolean {
  if (input === undefined) {
    return false;
  }
  if (!isConfigObject(input)) {
    throw new Error('invalid sandbox mode');
  }
  return (
    input.default !== undefined ||
    input.max !== undefined ||
    input.defaultMode !== undefined ||
    input.maxMode !== undefined
  );
}

function readAccess(value: unknown, field: string): AccessMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isAccessMode(value)) {
    throw new Error(`invalid permission ${field}`);
  }
  return value;
}

function readSandboxMode(value: unknown, field: string): CodexSandboxMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isCodexSandboxMode(value)) {
    throw new Error(`invalid sandbox ${field}`);
  }
  return value;
}

function isAccessMode(value: unknown): value is AccessMode {
  return value === 'read-only' || value === 'workspace' || value === 'full';
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCodexSandboxMode(value: unknown): value is CodexSandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access';
}

export function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return (
    value === 'default' ||
    value === 'acceptEdits' ||
    value === 'plan' ||
    value === 'auto' ||
    value === 'bypassPermissions'
  );
}

/**
 * Case-insensitive lookup for a mode typed by a human, returning the canonical
 * spelling. Two of the five modes are camelCase (`acceptEdits`,
 * `bypassPermissions`), so a chat argument that was lowercased for convenience
 * never compares equal to them — callers must resolve through here rather than
 * matching the raw input.
 */
export function resolveClaudePermissionMode(value: string): ClaudePermissionMode | undefined {
  const needle = value.trim().toLowerCase();
  return CLAUDE_PERMISSION_MODES.find((mode) => mode.toLowerCase() === needle);
}
