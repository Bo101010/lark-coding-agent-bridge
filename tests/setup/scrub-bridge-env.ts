/**
 * Bridge-injected environment variables describe *this* machine's running
 * bridge — which profile is active, where its state lives, which lark-cli
 * config dir the agent children get. They are correct for an agent run and
 * wrong for a test run.
 *
 * The suite is routinely executed from inside a bridge session (that is how
 * the bridge is developed), and the agent process exports all of these into
 * every child it spawns — including `pnpm test`. Left in place they silently
 * change test behavior:
 *
 *   - `LARK_CHANNEL_PROFILE` makes `resolveSecretAcrossProfiles` take its
 *     single-profile branch against a temp root that has no such profile.
 *   - `LARKSUITE_CLI_CONFIG_DIR` shows up in child envs that tests assert are
 *     clean, because the real code only sets it for the calls that need it.
 *   - `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS` leaks into the fake `claude` binary
 *     that records its own `process.env`.
 *
 * Scrub them so results are identical whether the suite runs from a terminal
 * or from inside a bridge-spawned agent. Tests that want any of these set
 * their own values explicitly.
 */
const BRIDGE_INJECTED_ENV = [
  'LARK_CHANNEL',
  'LARK_CHANNEL_PROFILE',
  'LARK_CHANNEL_HOME',
  'LARK_CHANNEL_CONFIG',
  'LARKSUITE_CLI_CONFIG_DIR',
  'CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS',
] as const;

for (const name of BRIDGE_INJECTED_ENV) {
  delete process.env[name];
}
