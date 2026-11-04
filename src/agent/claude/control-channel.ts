import type { Writable } from 'node:stream';
import { log } from '../../core/logger';
import type { HumanInputBroker } from '../human-input/broker';
import type {
  ControlRequestEnvelope,
  HumanInputAnswer,
  ToolPermissionDecision,
} from '../human-input/types';

/**
 * Host side of the CLI's stream-json control channel.
 *
 * With `--input-format stream-json --permission-prompts host`, the CLI stops
 * answering its own permission prompts and asks us instead, blocking the run
 * until a `control_response` with the matching `request_id` comes back. This
 * class owns that conversation; the adapter owns the process.
 *
 * Writes are serialized through a single stdin stream, so every frame is
 * newline-delimited JSON written in one `write()` call.
 */
export class ClaudeControlChannel {
  private readonly stdin: Writable;
  private readonly broker: HumanInputBroker | undefined;
  private readonly runId: string;
  private readonly scope: string;
  /** request_ids we have parked, so a cancel can find them. */
  private readonly inFlight = new Set<string>();
  private closed = false;

  constructor(options: {
    stdin: Writable;
    broker?: HumanInputBroker;
    runId: string;
    scope: string;
  }) {
    this.stdin = options.stdin;
    this.broker = options.broker;
    this.runId = options.runId;
    this.scope = options.scope;
  }

  /**
   * Opening handshake. Declares which dialog kinds we can render — the CLI
   * fails closed on anything absent here, so an undeclared kind is never
   * sent and its flow degrades to the no-dialog path.
   */
  sendInitialize(): void {
    const supportedDialogKinds = this.broker?.supportedDialogKinds() ?? [];
    this.write({
      type: 'control_request',
      request_id: `init-${this.runId}`,
      request: {
        subtype: 'initialize',
        ...(supportedDialogKinds.length > 0 ? { supportedDialogKinds } : {}),
      },
    });
    log.info('agent', 'control-initialize', {
      runId: this.runId,
      supportedDialogKinds,
    });
  }

  /** Send the user's turn as a stream-json message. */
  sendUserMessage(prompt: string): void {
    this.write({
      type: 'user',
      message: { role: 'user', content: prompt },
    });
  }

  /**
   * Handle one parsed stdout frame. Returns true if the frame belonged to
   * the control channel and must not be treated as a normal agent event.
   */
  handleFrame(frame: unknown): boolean {
    if (!frame || typeof frame !== 'object') return false;
    const record = frame as Record<string, unknown>;

    if (record.type === 'control_cancel_request') {
      const requestId = typeof record.request_id === 'string' ? record.request_id : '';
      if (requestId) {
        this.inFlight.delete(requestId);
        this.broker?.cancel(requestId, 'cancelled');
      }
      return true;
    }

    if (record.type === 'control_response') {
      // Replies to requests WE sent (e.g. initialize). Nothing to do beyond
      // noticing failures — the run proceeds either way.
      const response = record.response as Record<string, unknown> | undefined;
      if (response?.subtype === 'error') {
        log.warn('agent', 'control-response-error', {
          runId: this.runId,
          requestId: String(response.request_id ?? ''),
          error: String(response.error ?? ''),
        });
      }
      return true;
    }

    if (record.type !== 'control_request') return false;

    const envelope = parseControlRequest(record);
    if (!envelope) {
      log.warn('agent', 'control-request-malformed', { runId: this.runId });
      return true;
    }
    void this.dispatch(envelope);
    return true;
  }

  /** Run is ending: drop anything still parked so nothing waits on a dead process. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const requestId of this.inFlight) {
      this.broker?.cancel(requestId, 'run-ended');
    }
    this.inFlight.clear();
  }

  private async dispatch(envelope: ControlRequestEnvelope): Promise<void> {
    if (!this.broker) {
      // No broker wired up (feature off): decline rather than hang. Denying
      // is the honest answer — we cannot ask anyone.
      this.respondToolDecision(envelope, {
        behavior: 'deny',
        message: 'human-in-the-loop approval is not available in this bridge session',
      });
      return;
    }

    this.inFlight.add(envelope.request_id);
    let answer: HumanInputAnswer | undefined;
    try {
      answer = await this.broker.ask(envelope, { runId: this.runId, scope: this.scope });
    } catch (err) {
      log.fail('agent', err, { step: 'human-input', runId: this.runId });
    }
    this.inFlight.delete(envelope.request_id);

    if (this.closed) return;
    if (answer === undefined) {
      // Withdrawn or unrenderable. A cancelled request needs no reply; for
      // an unrenderable one an error-subtype response is discarded by the
      // CLI anyway, so staying silent is equivalent and simpler.
      return;
    }

    this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: envelope.request_id,
        response: answer as Record<string, unknown>,
      },
    });
  }

  private respondToolDecision(
    envelope: ControlRequestEnvelope,
    decision: ToolPermissionDecision,
  ): void {
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: envelope.request_id,
        response: decision as unknown as Record<string, unknown>,
      },
    });
  }

  private write(frame: unknown): void {
    if (this.stdin.destroyed || this.stdin.writableEnded) {
      log.warn('agent', 'control-write-after-end', { runId: this.runId });
      return;
    }
    this.stdin.write(`${JSON.stringify(frame)}\n`, 'utf8');
  }
}

function parseControlRequest(record: Record<string, unknown>): ControlRequestEnvelope | undefined {
  const requestId = record.request_id;
  const request = record.request;
  if (typeof requestId !== 'string' || !request || typeof request !== 'object') return undefined;

  const body = request as Record<string, unknown>;
  if (body.subtype === 'can_use_tool') {
    if (typeof body.tool_name !== 'string') return undefined;
    return {
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: body.tool_name,
        ...(typeof body.tool_use_id === 'string' ? { tool_use_id: body.tool_use_id } : {}),
        ...(isRecord(body.input) ? { input: body.input } : {}),
        ...(Array.isArray(body.permission_suggestions)
          ? { permission_suggestions: body.permission_suggestions }
          : {}),
      },
    };
  }

  if (body.subtype === 'request_user_dialog') {
    if (typeof body.dialog_kind !== 'string') return undefined;
    return {
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'request_user_dialog',
        dialog_kind: body.dialog_kind,
        ...(isRecord(body.payload) ? { payload: body.payload } : {}),
        ...(typeof body.tool_use_id === 'string' ? { tool_use_id: body.tool_use_id } : {}),
      },
    };
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
