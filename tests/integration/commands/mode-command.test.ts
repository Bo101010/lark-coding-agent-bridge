import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index';
import { resolveAppPaths } from '../../../src/config/app-paths';
import type { AccessMode } from '../../../src/config/permissions';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema';
import { runtimeProfileConfig } from '../../../src/config/profile-store';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('/mode', () => {
  it('lists the modes and marks the ones the access level rules out', async () => {
    const h = await createHarness({ maxAccess: 'workspace' });

    await h.command('/mode');

    const text = lastReply(h.channel);
    expect(text).toContain('当前 Claude 权限模式');
    expect(text).toContain('`acceptEdits`');
    expect(text).toContain('（超出 maxAccess，不可选）');
  });

  it('pins the mode in the profile config and in memory', async () => {
    const h = await createHarness({ maxAccess: 'full' });

    await h.command('/mode auto');

    const root = await waitForRoot(h.rootDir, (candidate) => {
      return candidate.profiles.claude?.permissions.claude?.permissionMode === 'auto';
    });
    expect(root.profiles.claude?.permissions.claude?.permissionMode).toBe('auto');
    // The live process reads the mode per run, so the in-memory copy has to
    // move too — otherwise the setting only lands after a restart.
    expect(h.controls.profileConfig.permissions.claude?.permissionMode).toBe('auto');
    expect(lastReply(h.channel)).toContain('`auto`');
  });

  it('resolves camelCase modes whatever case the user typed', async () => {
    // `acceptEdits` and `bypassPermissions` are camelCase, so an argument that
    // was lowercased for convenience would never match them by equality.
    const h = await createHarness({ maxAccess: 'full' });

    await h.command('/mode acceptEdits');

    const root = await waitForRoot(h.rootDir, (candidate) => {
      return candidate.profiles.claude?.permissions.claude?.permissionMode === 'acceptEdits';
    });
    expect(root.profiles.claude?.permissions.claude?.permissionMode).toBe('acceptEdits');
    expect(h.controls.profileConfig.permissions.claude?.permissionMode).toBe('acceptEdits');

    await h.command('/mode BYPASSPERMISSIONS');

    const next = await waitForRoot(h.rootDir, (candidate) => {
      return candidate.profiles.claude?.permissions.claude?.permissionMode === 'bypassPermissions';
    });
    expect(next.profiles.claude?.permissions.claude?.permissionMode).toBe('bypassPermissions');
  });

  it('takes effect when maxAccess sits above defaultAccess', async () => {
    // The exact shape that used to break: the pin is validated against
    // maxAccess, so `auto` saves — but the resolver compared it against the
    // derived access (workspace) and quietly ran `default` instead.
    const h = await createHarness({ defaultAccess: 'workspace', maxAccess: 'full' });

    await h.command('/mode auto');

    const root = await waitForRoot(h.rootDir, (candidate) => {
      return candidate.profiles.claude?.permissions.claude?.permissionMode === 'auto';
    });
    expect(root.profiles.claude?.permissions.claude?.permissionMode).toBe('auto');
    expect(lastReply(h.channel)).toContain('已固定为 `auto`');

    await h.command('/mode');

    const listing = lastReply(h.channel);
    expect(listing).toContain('当前 Claude 权限模式:`auto`');
    expect(listing).toContain('固定为 `auto`');
  });

  it('keeps askHuman when pinning a mode', async () => {
    const h = await createHarness({ maxAccess: 'full', askHuman: true });

    await h.command('/mode auto');

    const root = await waitForRoot(h.rootDir, (candidate) => {
      return candidate.profiles.claude?.permissions.claude?.permissionMode === 'auto';
    });
    expect(root.profiles.claude?.permissions.claude?.askHuman).toBe(true);
  });

  it('refuses a mode that exceeds maxAccess, and writes nothing', async () => {
    const h = await createHarness({ maxAccess: 'workspace' });
    const before = await readRoot(h.rootDir);

    await h.command('/mode auto');

    expect(lastReply(h.channel)).toContain('超出当前 maxAccess');
    expect(await readRoot(h.rootDir)).toEqual(before);
    expect(h.controls.profileConfig.permissions.claude?.permissionMode).toBeUndefined();
  });

  it('clears the pin on /mode reset', async () => {
    const h = await createHarness({ maxAccess: 'full' });
    await h.command('/mode plan');

    await h.command('/mode reset');

    const root = await waitForRoot(h.rootDir, (candidate) => {
      return candidate.profiles.claude?.permissions.claude?.permissionMode === undefined;
    });
    expect(root.profiles.claude?.permissions.claude?.permissionMode).toBeUndefined();
    expect(lastReply(h.channel)).toContain('已清除固定模式');
  });

  it('rejects an unknown mode', async () => {
    const h = await createHarness({ maxAccess: 'full' });

    await h.command('/mode yolo');

    expect(lastReply(h.channel)).toContain('未知模式');
    expect((await readRoot(h.rootDir)).profiles.claude?.permissions.claude).toBeUndefined();
  });

  it('is admin-only', async () => {
    const h = await createHarness({ maxAccess: 'full' });

    await h.command('/mode auto', { senderId: 'ou-someone-else' });

    expect(lastReply(h.channel)).toContain('仅管理员可用');
    expect((await readRoot(h.rootDir)).profiles.claude?.permissions.claude).toBeUndefined();
  });
});

async function createHarness(
  options: { maxAccess: AccessMode; defaultAccess?: AccessMode; askHuman?: boolean } = {
    maxAccess: 'full',
  },
): Promise<{
  rootDir: string;
  channel: FakeChannel;
  controls: Controls;
  command(content: string, overrides?: { senderId?: string }): Promise<boolean>;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), 'bridge-mode-command-'));
  roots.push(rootDir);
  const workspace = join(rootDir, 'workspace');
  await mkdir(workspace, { recursive: true });
  const root = await writeRoot(rootDir, workspace, options);
  const appPaths = resolveAppPaths({ rootDir, profile: 'claude' });
  const channel = createFakeChannel();
  const sessions = new SessionStore(appPaths.sessionsFile);
  const workspaces = new WorkspaceStore(appPaths.workspacesFile);
  const controls = {
    profile: 'claude',
    profileConfig: root.profiles.claude!,
    botOwnerId: 'ou-admin',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: appPaths.configFile,
    cfg: runtimeProfileConfig(root, 'claude'),
    processId: 'proc-1',
  } satisfies Controls;

  return {
    rootDir,
    channel,
    controls,
    command: (content, overrides = {}) =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: message(content, overrides.senderId ?? 'ou-admin'),
        scope: 'chat-1',
        chatMode: 'p2p',
        sessions,
        workspaces,
        agent: new FakeAgentAdapter(),
        activeRuns: new ActiveRuns(),
        controls,
        fromCardAction: false,
      }),
  };
}

async function writeRoot(
  rootDir: string,
  workspace: string,
  options: { maxAccess: AccessMode; defaultAccess?: AccessMode; askHuman?: boolean },
): Promise<RootConfig> {
  const profile = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_old', secret: '${APP_SECRET}', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
  });
  profile.permissions = {
    defaultAccess: options.defaultAccess ?? options.maxAccess,
    maxAccess: options.maxAccess,
    ...(options.askHuman ? { claude: { askHuman: true } } : {}),
  };
  profile.workspaces.default = workspace;
  const root: RootConfig = {
    schemaVersion: 2,
    activeProfile: 'claude',
    preferences: {},
    profiles: { claude: profile },
  };
  await writeJson(resolveAppPaths({ rootDir }).configFile, root);
  await writeFile(join(rootDir, 'active-profile'), 'claude\n', 'utf8');
  return root;
}

async function readRoot(rootDir: string): Promise<RootConfig> {
  return JSON.parse(await readFile(resolveAppPaths({ rootDir }).configFile, 'utf8')) as RootConfig;
}

async function waitForRoot(
  rootDir: string,
  predicate: (root: RootConfig) => boolean,
): Promise<RootConfig> {
  let lastRoot = await readRoot(rootDir);
  await vi.waitFor(
    async () => {
      lastRoot = await readRoot(rootDir);
      expect(predicate(lastRoot)).toBe(true);
    },
    { timeout: 5000 },
  );
  return lastRoot;
}

/** The markdown of the most recent reply the handler sent back. */
function lastReply(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as
    | { markdown?: string; text?: string; card?: object }
    | undefined;
  return content?.markdown ?? content?.text ?? JSON.stringify(content?.card ?? '');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function message(content: string, senderId: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId,
    senderName: senderId === 'ou-admin' ? 'Admin' : 'Someone',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
