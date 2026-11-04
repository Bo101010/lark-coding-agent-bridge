/**
 * Wire types for the CLI's host-side human-in-the-loop control protocol.
 *
 * The CLI asks the host two kinds of questions over the stream-json control
 * channel, and blocks the run until the host answers:
 *
 *   - `can_use_tool`         — a tool permission prompt
 *   - `request_user_dialog`  — any other blocking decision, discriminated by
 *                              an OPEN string union `dialog_kind`
 *
 * Everything else on the control channel (`ui_*`) is terminal rendering, not
 * a question for a human, and is out of scope here.
 */

/** Envelope the CLI writes on stdout when it needs an answer from the host. */
export interface ControlRequestEnvelope {
  type: 'control_request';
  request_id: string;
  request: CanUseToolRequest | RequestUserDialogRequest;
}

/**
 * The CLI withdrew a request it had previously asked. Any UI still showing
 * it is stale: the run has already moved on and an answer would be discarded.
 */
export interface ControlCancelEnvelope {
  type: 'control_cancel_request';
  request_id: string;
}

export interface CanUseToolRequest {
  subtype: 'can_use_tool';
  tool_name: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
  /**
   * Pre-built permission rules the CLI suggests for an "always allow" style
   * answer. Passing one back verbatim in `updatedPermissions` is far safer
   * than synthesizing rule content ourselves — the CLI owns that grammar.
   */
  permission_suggestions?: unknown[];
}

export interface RequestUserDialogRequest {
  subtype: 'request_user_dialog';
  /**
   * Open string union — new kinds may appear without a protocol version
   * bump. A kind only ever reaches us if we declared it in
   * `initialize.supportedDialogKinds`.
   */
  dialog_kind: string;
  payload?: Record<string, unknown>;
  tool_use_id?: string;
}

/** Host → CLI reply. Exactly one per request_id. */
export type ControlResponseEnvelope =
  | {
      type: 'control_response';
      response: { subtype: 'success'; request_id: string; response?: Record<string, unknown> };
    }
  | {
      type: 'control_response';
      response: { subtype: 'error'; request_id: string; error: string };
    };

/**
 * Decision for a `can_use_tool` request.
 *
 * `updatedPermissions` is how "always allow" is expressed. Entries with
 * `destination: 'localSettings'` are persisted by the CLI itself into the
 * project's `.claude/settings.local.json` — we deliberately do NOT write
 * that file ourselves, to avoid racing the CLI's own writer and to inherit
 * its rule grammar for free.
 */
export type ToolPermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export type DialogDecision = Record<string, unknown>;

export type HumanInputKind = 'can_use_tool' | `dialog:${string}`;

/** A question currently parked, waiting for a human. */
export interface PendingHumanInput {
  requestId: string;
  runId: string;
  scope: string;
  kind: HumanInputKind;
  request: CanUseToolRequest | RequestUserDialogRequest;
  askedAt: number;
}

export type HumanInputAnswer = ToolPermissionDecision | DialogDecision;
