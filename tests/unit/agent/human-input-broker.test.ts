import { describe, expect, it, vi } from 'vitest';
import { HumanInputBroker, type HumanInputRenderer } from '../../../src/agent/human-input/broker';
import type {
  ControlRequestEnvelope,
  HumanInputKind,
  PendingHumanInput,
} from '../../../src/agent/human-input/types';

describe('HumanInputBroker', () => {
  it('parks a tool permission request until a human answers it', async () => {
    const renderer = recordingRenderer(['can_use_tool']);
    const broker = new HumanInputBroker({ renderers: [renderer] });

    const asked = broker.ask(toolRequest('req-1'), { runId: 'run-1', scope: 'oc_x' });
    await renderer.rendered;

    // Still parked: nothing resolves the promise but an explicit answer.
    expect(broker.pendingForScope('oc_x')).toHaveLength(1);

    broker.answer('req-1', { behavior: 'allow' });
    await expect(asked).resolves.toEqual({ behavior: 'allow' });
    expect(broker.pendingForScope('oc_x')).toHaveLength(0);
  });

  it('never auto-settles a parked request on its own', async () => {
    vi.useFakeTimers();
    try {
      const renderer = recordingRenderer(['can_use_tool']);
      const broker = new HumanInputBroker({ renderers: [renderer] });

      let settled = false;
      void broker
        .ask(toolRequest('req-wait'), { runId: 'run-1', scope: 'oc_x' })
        .then(() => {
          settled = true;
        });
      await renderer.rendered;

      // Far beyond any plausible deadline — the bridge imposes none, and the
      // CLI's own dialog deadline is disabled by the adapter.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(broker.pendingForScope('oc_x')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the pool slot while parked and reacquires before answering', async () => {
    const order: string[] = [];
    const renderer = recordingRenderer(['can_use_tool']);
    const broker = new HumanInputBroker({
      renderers: [renderer],
      onPark: async () => {
        order.push('released');
        return async () => {
          order.push('reacquired');
        };
      },
    });

    const asked = broker.ask(toolRequest('req-2'), { runId: 'run-1', scope: 'oc_x' });
    await renderer.rendered;
    expect(order).toEqual(['released']);

    broker.answer('req-2', { behavior: 'allow' });
    await asked;

    expect(order).toEqual(['released', 'reacquired']);
  });

  it('resolves without an answer when the CLI withdraws the request', async () => {
    const renderer = recordingRenderer(['can_use_tool']);
    const broker = new HumanInputBroker({ renderers: [renderer] });

    const asked = broker.ask(toolRequest('req-3'), { runId: 'run-1', scope: 'oc_x' });
    await renderer.rendered;

    broker.cancel('req-3');

    await expect(asked).resolves.toBeUndefined();
    expect(renderer.withdrawn).toEqual([['req-3', 'cancelled']]);
  });

  it('tears down every request parked for a stopped run', async () => {
    const renderer = recordingRenderer(['can_use_tool']);
    const broker = new HumanInputBroker({ renderers: [renderer] });

    const a = broker.ask(toolRequest('req-a'), { runId: 'run-1', scope: 'oc_x' });
    const b = broker.ask(toolRequest('req-b'), { runId: 'run-2', scope: 'oc_y' });
    await renderer.renderedCount(2);

    broker.cancelRun('run-1');

    await expect(a).resolves.toBeUndefined();
    expect(broker.pendingForScope('oc_y')).toHaveLength(1);

    broker.answer('req-b', { behavior: 'allow' });
    await b;
  });

  it('ignores an answer for a request that is no longer parked', async () => {
    const broker = new HumanInputBroker({ renderers: [recordingRenderer(['can_use_tool'])] });
    expect(broker.answer('nope', { behavior: 'allow' })).toBe(false);
  });

  it('settles rather than wedging the run when rendering fails', async () => {
    const renderer: HumanInputRenderer = {
      kinds: ['can_use_tool'],
      render: () => Promise.reject(new Error('lark down')),
    };
    const broker = new HumanInputBroker({ renderers: [renderer] });

    await expect(
      broker.ask(toolRequest('req-4'), { runId: 'run-1', scope: 'oc_x' }),
    ).resolves.toBeUndefined();
  });

  it('declares only dialog kinds that have a renderer', () => {
    const broker = new HumanInputBroker({
      renderers: [
        recordingRenderer(['can_use_tool']),
        recordingRenderer(['dialog:repository_trust', 'dialog:refusal_fallback']),
      ],
    });

    // can_use_tool is not a dialog kind and must not be declared as one.
    expect(broker.supportedDialogKinds()).toEqual(['refusal_fallback', 'repository_trust']);
  });

  it('rejects two renderers claiming the same kind', () => {
    expect(
      () =>
        new HumanInputBroker({
          renderers: [recordingRenderer(['can_use_tool']), recordingRenderer(['can_use_tool'])],
        }),
    ).toThrow(/duplicate human-input renderer/);
  });

  it('does not answer a dialog kind it cannot render', async () => {
    const broker = new HumanInputBroker({ renderers: [recordingRenderer(['can_use_tool'])] });

    const envelope: ControlRequestEnvelope = {
      type: 'control_request',
      request_id: 'req-5',
      request: { subtype: 'request_user_dialog', dialog_kind: 'kind_from_the_future' },
    };

    await expect(broker.ask(envelope, { runId: 'run-1', scope: 'oc_x' })).resolves.toBeUndefined();
  });
});

function toolRequest(requestId: string): ControlRequestEnvelope {
  return {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      input: { command: 'echo hi' },
    },
  };
}

interface RecordingRenderer extends HumanInputRenderer {
  rendered: Promise<void>;
  renderedCount(n: number): Promise<void>;
  withdrawn: Array<[string, string]>;
}

function recordingRenderer(kinds: HumanInputKind[]): RecordingRenderer {
  const seen: PendingHumanInput[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  const withdrawn: Array<[string, string]> = [];

  const notify = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]!;
      if (seen.length >= waiter.n) {
        waiter.resolve();
        waiters.splice(i, 1);
      }
    }
  };
  const renderedCount = (n: number): Promise<void> =>
    seen.length >= n ? Promise.resolve() : new Promise<void>((resolve) => {
      waiters.push({ n, resolve });
    });

  return {
    kinds,
    withdrawn,
    get rendered() {
      return renderedCount(1);
    },
    renderedCount,
    render: (pending) => {
      seen.push(pending);
      notify();
      return Promise.resolve();
    },
    withdraw: (pending, reason) => {
      withdrawn.push([pending.requestId, reason]);
      return Promise.resolve();
    },
  };
}
