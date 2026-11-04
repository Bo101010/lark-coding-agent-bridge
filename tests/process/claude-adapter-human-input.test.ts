import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';
import { HumanInputBroker, type HumanInputRenderer } from '../../src/agent/human-input/broker.js';
import type { PendingHumanInput } from '../../src/agent/human-input/types.js';
import type { AgentEvent } from '../../src/agent/types.js';

/**
 * End-to-end contract for the interactive (human-in-the-loop) run mode:
 * the CLI asks, the bridge parks the question, a human answers, and the run
 * resumes. Exercised against a fake CLI that speaks the real control
 * protocol over stdin/stdout.
 */
describe('ClaudeAdapter human-in-the-loop contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('keeps the legacy one-shot contract when no broker is wired up', async () => {
    const fake = await createInteractiveClaude({ askPermission: false });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-legacy',
      prompt: 'hello',
      cwd: fake.dir,
      permissionMode: 'acceptEdits',
    });
    await collect(run.events);

    const record = await readRecord(fake.recordPath);
    expect(record.argv).not.toContain('--input-format');
    expect(record.argv).not.toContain('--permission-prompts');
    expect(record.argv).not.toContain('--permission-prompt-tool');
    expect(record.env.CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS).toBeUndefined();
    // Prompt still arrives as raw stdin text, not a stream-json frame.
    expect(record.stdinLines).toEqual(['hello']);
  });

  it('asks a human for tool permission and resumes the run with the answer', async () => {
    const fake = await createInteractiveClaude({ askPermission: true });
    cleanup.push(fake.dir);

    const asked: PendingHumanInput[] = [];
    const broker = new HumanInputBroker({
      renderers: [
        {
          kinds: ['can_use_tool'],
          render: (pending) => {
            asked.push(pending);
            // Stand in for a human tapping "始终允许" on the Lark card.
            broker.answer(pending.requestId, {
              behavior: 'allow',
              updatedPermissions: [
                {
                  type: 'addRules',
                  rules: [{ toolName: 'Bash', ruleContent: 'echo *' }],
                  behavior: 'allow',
                  destination: 'localSettings',
                },
              ],
            });
            return Promise.resolve();
          },
        } satisfies HumanInputRenderer,
      ],
    });

    const run = new ClaudeAdapter({ binary: fake.path, humanInput: broker }).run({
      runId: 'run-hitl',
      prompt: 'run a command',
      cwd: fake.dir,
      scopeId: 'oc_scope',
      permissionMode: 'default',
    });

    const events = await collect(run.events);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      kind: 'can_use_tool',
      scope: 'oc_scope',
      runId: 'run-hitl',
      request: { subtype: 'can_use_tool', tool_name: 'Bash' },
    });
    // The run only reaches 'done' if the CLI received a usable answer.
    expect(events.at(-1)).toMatchObject({ type: 'done' });

    const record = await readRecord(fake.recordPath);
    expect(record.argv).toContain('--input-format');
    expect(record.argv).toContain('--permission-prompts');
    expect(record.argv[record.argv.indexOf('--permission-prompts') + 1]).toBe('host');
    // The host permission surface only exists when this is exactly `stdio`.
    // Without it the CLI never emits can_use_tool at all and every ask
    // settles as a fail-closed denial, so a run that "works" here would
    // still be unable to ask anyone anything.
    expect(record.argv).toContain('--permission-prompt-tool');
    expect(record.argv[record.argv.indexOf('--permission-prompt-tool') + 1]).toBe('stdio');
    // The CLI's own dialog deadline must be off, or a parked card would
    // silently expire after 5 minutes.
    expect(record.env.CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS).toBe('never');

    const frames = record.stdinLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const initialize = frames.find(
      (f) => (f.request as Record<string, unknown> | undefined)?.subtype === 'initialize',
    );
    expect(initialize).toBeDefined();
    expect(frames.some((f) => f.type === 'user')).toBe(true);

    const decision = frames.find((f) => f.type === 'control_response');
    expect(decision).toMatchObject({
      type: 'control_response',
      response: { subtype: 'success', response: { behavior: 'allow' } },
    });
  });

  it('declares exactly the dialog kinds it can render', async () => {
    const fake = await createInteractiveClaude({ askPermission: false });
    cleanup.push(fake.dir);

    const broker = new HumanInputBroker({
      renderers: [
        { kinds: ['can_use_tool'], render: () => Promise.resolve() },
        { kinds: ['dialog:repository_trust'], render: () => Promise.resolve() },
      ],
    });

    const run = new ClaudeAdapter({ binary: fake.path, humanInput: broker }).run({
      runId: 'run-kinds',
      prompt: 'hi',
      cwd: fake.dir,
      scopeId: 'oc_scope',
    });
    await collect(run.events);

    const record = await readRecord(fake.recordPath);
    const initialize = record.stdinLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((f) => (f.request as Record<string, unknown> | undefined)?.subtype === 'initialize');

    expect((initialize?.request as Record<string, unknown>).supportedDialogKinds).toEqual([
      'repository_trust',
    ]);
  });

  it('stops waiting on a question the CLI withdraws', async () => {
    const fake = await createInteractiveClaude({ askPermission: true, cancelAfterAsk: true });
    cleanup.push(fake.dir);

    const withdrawn: string[] = [];
    const broker = new HumanInputBroker({
      renderers: [
        {
          kinds: ['can_use_tool'],
          // Never answered — the CLI takes it back instead.
          render: () => Promise.resolve(),
          withdraw: (pending) => {
            withdrawn.push(pending.requestId);
            return Promise.resolve();
          },
        } satisfies HumanInputRenderer,
      ],
    });

    const run = new ClaudeAdapter({ binary: fake.path, humanInput: broker }).run({
      runId: 'run-cancel',
      prompt: 'hi',
      cwd: fake.dir,
      scopeId: 'oc_scope',
    });
    await collect(run.events);

    expect(withdrawn).toHaveLength(1);
    expect(broker.pendingForScope('oc_scope')).toHaveLength(0);
  });

  it('releases a parked question when the run is stopped', async () => {
    const fake = await createInteractiveClaude({ askPermission: true, hangAfterAsk: true });
    cleanup.push(fake.dir);

    const broker = new HumanInputBroker({
      renderers: [{ kinds: ['can_use_tool'], render: () => Promise.resolve() }],
    });

    const adapter = new ClaudeAdapter({ binary: fake.path, humanInput: broker });
    const run = adapter.run({
      runId: 'run-stop',
      prompt: 'hi',
      cwd: fake.dir,
      scopeId: 'oc_scope',
      stopGraceMs: 200,
    });

    const drained = collect(run.events);
    await waitFor(() => broker.pendingForScope('oc_scope').length === 1);

    // `/stop` is the escape hatch for an indefinitely parked question.
    await run.stop();
    await drained;

    expect(broker.pendingForScope('oc_scope')).toHaveLength(0);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const evt of events) out.push(evt);
  return out;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

/**
 * Fake CLI that speaks the control protocol: it reads newline-delimited
 * frames from stdin and, unlike the one-shot fake, does not wait for stdin
 * to end (an interactive run holds it open for the whole turn).
 */
async function createInteractiveClaude(options: {
  askPermission: boolean;
  cancelAfterAsk?: boolean;
  hangAfterAsk?: boolean;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-hitl-test-'));
  const path = join(dir, 'fake-claude.mjs');
  const recordPath = join(dir, 'record.json');

  const script = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const stdinLines = [];
const record = () => writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
  argv,
  stdinLines,
  cwd: process.cwd(),
  env: {
    LARK_CHANNEL: process.env.LARK_CHANNEL,
    CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS: process.env.CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS,
  },
}));

const interactive = argv.includes("--input-format");
// Mirrors the real CLI: the host permission surface only exists when
// --permission-prompt-tool is exactly "stdio". --permission-prompts alone
// does not install one.
const hostSurface = argv[argv.indexOf("--permission-prompt-tool") + 1] === "stdio";
const askPermission = ${JSON.stringify(options.askPermission)};
const cancelAfterAsk = ${JSON.stringify(options.cancelAfterAsk ?? false)};
const hangAfterAsk = ${JSON.stringify(options.hangAfterAsk ?? false)};
const say = (frame) => console.log(JSON.stringify(frame));

const finish = () => {
  record();
  say({ type: "result", session_id: "sess-hitl" });
  setTimeout(() => process.exit(0), 10);
};

if (!interactive) {
  // Legacy one-shot: prompt arrives as raw text and stdin ends.
  let buf = "";
  process.stdin.on("data", (c) => { buf += c; });
  process.stdin.on("end", () => { stdinLines.push(buf); finish(); });
} else {
  const rl = createInterface({ input: process.stdin });
  let askedId = null;
  rl.on("line", (line) => {
    if (!line.trim()) return;
    stdinLines.push(line);
    let frame;
    try { frame = JSON.parse(line); } catch { return; }

    if (frame.type === "user") {
      if (!askPermission) { finish(); return; }
      if (!hostSurface) {
        // No host surface to ask: the real CLI denies locally and settles the
        // tool_result as ask_refused_no_surface. Nothing reaches the broker.
        say({ type: "system", subtype: "permission_denied", tool_name: "Bash", message: "ask_refused_no_surface" });
        finish();
        return;
      }
      askedId = "perm-1";
      say({
        type: "control_request",
        request_id: askedId,
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          tool_use_id: "toolu_1",
          input: { command: "echo hi" },
        },
      });
      if (cancelAfterAsk) {
        setTimeout(() => {
          say({ type: "control_cancel_request", request_id: askedId });
          setTimeout(finish, 20);
        }, 30);
      }
      // hangAfterAsk: deliberately never settle; the test stops the run.
      return;
    }

    if (frame.type === "control_response" && !hangAfterAsk && !cancelAfterAsk) {
      // Got the human's decision — the turn can complete.
      finish();
    }
  });
  // Record argv/env early so a stopped run still leaves evidence behind.
  record();
}
`;

  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  stdinLines: string[];
  cwd: string;
  env: { LARK_CHANNEL?: string; CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS?: string };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    stdinLines: string[];
    cwd: string;
    env: { LARK_CHANNEL?: string; CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS?: string };
  };
}
