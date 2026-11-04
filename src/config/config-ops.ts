import { dirname } from 'node:path';
import { resolveAppPaths } from './app-paths';
import { setSecret } from './keystore';
import {
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
  withConfigFileLock,
} from './profile-store';
import { saveConfig } from './store';
import { secretKeyForApp, type AppConfig, type AppPreferences } from './schema';
import type {
  PermissionConfig,
  ProfileAccess,
  ProfileConfig,
  ProfileMode,
} from './profile-schema';
import type { ClaudePermissionMode } from './permissions';
import { applyLarkCliIdentityPolicy } from '../lark-cli/identity-policy';
import { log, reportMetric } from '../core/logger';

/**
 * The mutable per-profile runtime state these ops read and keep in sync. The
 * running bridge's `Controls` object structurally satisfies this, so both the
 * chat `/config` handlers and the local web UI's REST layer drive config
 * changes through the exact same disk-write + in-memory-refresh logic (no
 * divergent second implementation). `cfg` / `profileConfig` are reassigned in
 * place after a successful save so the live process picks up changes without a
 * restart — mirroring how the chat form already applies preferences/access.
 */
export interface MutableProfileState {
  configPath: string;
  profile: string;
  cfg: AppConfig;
  profileConfig: ProfileConfig;
}

/** App paths for a profile, derived from its config path. */
export function profileAppPaths(state: Pick<MutableProfileState, 'configPath' | 'profile'>) {
  return resolveAppPaths({
    rootDir: dirname(state.configPath),
    profile: state.profile,
  });
}

/**
 * Apply the lark-cli identity policy (`strict-mode` + `default-as`) for a
 * profile. Pass the *effective* preset (team mode forces `bot-only` — see
 * {@link effectiveLarkCliIdentity}). Returns false on failure (logged).
 */
export async function applyProfileLarkCliIdentity(
  state: Pick<MutableProfileState, 'configPath' | 'profile'>,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
): Promise<boolean> {
  const appPaths = profileAppPaths(state);
  const ok = await applyLarkCliIdentityPolicy({
    profile: appPaths.profile,
    rootDir: appPaths.rootDir,
    configPath: state.configPath,
    larkCliConfigDir: appPaths.larkCliConfigDir,
    larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
  }, larkCliIdentity).catch(() => false);
  if (!ok) {
    log.warn('config-ops', 'lark-cli-identity-policy-apply-failed', {
      profile: appPaths.profile,
      identity: larkCliIdentity,
    });
  }
  return ok;
}

/**
 * Mutate the profile's access lists (allowlists + admins) under the config
 * file lock, persist, and refresh the in-memory state. `mutate` receives the
 * current {@link ProfileAccess} and returns the next one.
 */
export async function saveAccessConfig(
  state: MutableProfileState,
  mutate: (access: ProfileAccess) => ProfileAccess,
): Promise<ProfileAccess> {
  try {
    return await withConfigFileLock(state.configPath, async () => {
      const root = await loadRootConfig(state.configPath);
      if (!root) {
        const access = mutate(state.profileConfig.access);
        state.profileConfig = {
          ...state.profileConfig,
          access,
        };
        state.cfg.preferences = {
          ...(state.cfg.preferences ?? {}),
          access: {
            allowedUsers: access.allowedUsers,
            allowedChats: access.allowedChats,
            admins: access.admins,
            ...(access.chatRequireMention && Object.keys(access.chatRequireMention).length > 0
              ? { chatRequireMention: access.chatRequireMention }
              : {}),
          },
          requireMentionInGroup: access.requireMentionInGroup,
        };
        await saveConfig(state.cfg, state.configPath);
        return access;
      }

      const profile = root.profiles[state.profile];
      if (!profile) throw new Error(`profile not found: ${state.profile}`);
      const access = mutate(profile.access);
      root.profiles[state.profile] = {
        ...profile,
        access,
      };
      await saveRootConfig(root, state.configPath);
      state.profileConfig = root.profiles[state.profile]!;
      state.cfg = runtimeProfileConfig(root, state.profile);
      log.info('config-ops', 'access-mutated', {
        allowedUsers: access.allowedUsers.length,
        allowedChats: access.allowedChats.length,
        admins: access.admins.length,
      });
      return access;
    });
  } catch (err) {
    reportMetric('command_fail', 1, { step: 'access.save' });
    throw err;
  }
}

/**
 * Pin (or clear) the profile's Claude permission mode under the config file
 * lock, refreshing in-memory state. `undefined` removes the override so the
 * mode goes back to being derived from the access level.
 *
 * Unlike `askHuman`, which is read once at startChannel time to decide whether
 * to install the human-in-the-loop surface, the mode is read per run from
 * `profileConfig.permissions` — so a change here takes effect on the next run
 * without a restart.
 */
export async function saveClaudePermissionMode(
  state: MutableProfileState,
  mode: ClaudePermissionMode | undefined,
): Promise<void> {
  try {
    await withConfigFileLock(state.configPath, async () => {
      const root = await loadRootConfig(state.configPath);
      if (!root) throw new Error(`config not found: ${state.configPath}`);
      const profile = root.profiles[state.profile];
      if (!profile) throw new Error(`profile not found: ${state.profile}`);

      const next = withClaudePermissionMode(profile.permissions, mode);
      root.profiles[state.profile] = { ...profile, permissions: next };
      await saveRootConfig(root, state.configPath);
      state.profileConfig = root.profiles[state.profile]!;
      state.cfg = runtimeProfileConfig(root, state.profile);
      log.info('config-ops', 'claude-permission-mode-set', {
        profile: state.profile,
        permissionMode: mode ?? null,
      });
    });
  } catch (err) {
    reportMetric('command_fail', 1, { step: 'claude-permission-mode.save' });
    throw err;
  }
}

/** Set or drop `claude.permissionMode` without disturbing `askHuman` or the
 * rest of the claude block; drop the block entirely when it would be empty. */
function withClaudePermissionMode(
  permissions: PermissionConfig,
  mode: ClaudePermissionMode | undefined,
): PermissionConfig {
  const { permissionMode: _previous, ...restClaude } = permissions.claude ?? {};
  const claude = mode === undefined ? restClaude : { ...restClaude, permissionMode: mode };
  const { claude: _drop, ...withoutClaude } = permissions;
  return Object.keys(claude).length > 0 ? { ...withoutClaude, claude } : withoutClaude;
}

/**
 * Store a new App Secret in the keystore and persist the account config
 * (SecretRef in config.json, plaintext only in the keystore), refreshing
 * in-memory state. Callers restart the bridge afterwards to reconnect with
 * the new credentials.
 */
export async function saveAccountConfig(
  state: MutableProfileState,
  newCfg: AppConfig,
  plaintextSecret: string,
): Promise<void> {
  const appPaths = profileAppPaths(state);
  await setSecret(secretKeyForApp(newCfg.accounts.app.id), plaintextSecret, appPaths);

  const root = await loadRootConfig(state.configPath);
  if (!root) {
    await saveConfig(newCfg, state.configPath);
    state.cfg = newCfg;
    return;
  }

  const profile = root.profiles[state.profile];
  if (!profile) throw new Error(`profile not found: ${state.profile}`);
  root.profiles[state.profile] = {
    ...profile,
    accounts: newCfg.accounts,
  };
  if (newCfg.secrets) root.secrets = newCfg.secrets;
  await saveRootConfig(root, state.configPath);
  state.profileConfig = root.profiles[state.profile]!;
  state.cfg = runtimeProfileConfig(root, state.profile);
}

/**
 * Persist preferences + deployment mode + lark-cli identity + require-mention
 * under the config file lock, refreshing in-memory state. Stores the user's
 * identity selection verbatim (not the team-mode-forced effective preset) so
 * it comes back into effect when switching to personal mode.
 */
export async function savePreferencesConfig(
  state: MutableProfileState,
  preferences: AppPreferences,
  requireMentionInGroup: boolean,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
  mode: ProfileMode,
  /** In-meeting agent settings; omitted by callers that don't edit them. */
  meeting?: ProfileConfig['meeting'],
): Promise<void> {
  const larkCli = {
    identityPreset: larkCliIdentity,
    localUserImport: {
      status: 'not-needed' as const,
      attemptedAt: new Date().toISOString(),
      reason: larkCliIdentity === 'user-default' ? 'manual-user-default' : 'manual-bot-only',
    },
  };
  await withConfigFileLock(state.configPath, async () => {
    const root = await loadRootConfig(state.configPath);
    if (!root) {
      state.cfg.preferences = preferences;
      state.profileConfig.larkCli = larkCli;
      state.profileConfig.mode = mode;
      if (meeting) state.profileConfig.meeting = meeting;
      await saveConfig(state.cfg, state.configPath);
      return;
    }

    const profile = root.profiles[state.profile];
    if (!profile) throw new Error(`profile not found: ${state.profile}`);
    const { requireMentionInGroup: _requireMention, access: _access, ...profilePreferences } = preferences;
    root.profiles[state.profile] = {
      ...profile,
      mode,
      preferences: {
        ...profile.preferences,
        ...profilePreferences,
      },
      access: {
        ...profile.access,
        requireMentionInGroup,
      },
      ...(meeting ? { meeting } : {}),
      larkCli,
    };
    await saveRootConfig(root, state.configPath);
    state.profileConfig = root.profiles[state.profile]!;
    state.cfg = runtimeProfileConfig(root, state.profile);
  });
}
