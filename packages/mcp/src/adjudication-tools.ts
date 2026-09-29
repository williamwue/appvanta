import { previewUncertainTaskStep, recordUncertainStepAdjudication, prepareAdjudicatedTaskContinuation,
  reserveAdjudicatedSuccessor, type TaskStore, type SuccessorReservationReceipt } from '@appvanta/core';
import { continueAdjudicatedAndroidTask, restartAdjudicatedAndroidTask } from '@appvanta/android';
import { definitions } from './schemas.js';

const uuid = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const taskId = { type: 'string', pattern: '^task-[a-f0-9-]{36}$' };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const expectation = { decisionId: uuid, previewDigestSha256: digest, leaseToken: uuid };
const receipt = object({ ...expectation, preparationId: uuid, preparationDigestSha256: digest, timeoutMs: { type: 'integer', minimum: 1, maximum: 3600000 } }, [...Object.keys(expectation), 'preparationId', 'preparationDigestSha256']);
const label = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '^[^\\s\\u0000-\\u001f\\u007f](?:[^\\u0000-\\u001f\\u007f]*[^\\s\\u0000-\\u001f\\u007f])?$' });
const decision = {
  ...object({ expectedPreviewDigestSha256: digest, expectedLeaseToken: uuid, operator: label(120), reason: label(1000),
    verdict: { enum: ['unresolved', 'postcondition-verified-skip'] },
    postconditionCheckpoint: { allOf: [{ $ref: '#/$defs/condition' }, { properties: { kind: { not: { enum: ['ui-changed', 'screen-stable'] } } } }] },
  }, ['expectedPreviewDigestSha256', 'expectedLeaseToken', 'operator', 'reason', 'verdict']),
  if: { properties: { verdict: { const: 'postcondition-verified-skip' } } },
  then: { required: ['postconditionCheckpoint'] },
  else: { not: { required: ['postconditionCheckpoint'] } },
};

export const adjudicationTools = [
  { name: 'preview_uncertain_task', description: 'Read uncertain successor evidence without changing task or device state. Does not authorize execution.', inputSchema: object({ taskId }) },
  { name: 'adjudicate_task', description: 'Persist an explicit operator decision about an uncertain step. Supply independently observed postcondition evidence; recording a decision does not execute the device.', inputSchema: { ...object({ taskId, decision }), $defs: definitions } },
  { name: 'prepare_adjudicated_task', description: 'Prepare a guarded Flow from a recorded decision and exact evidence expectation. Retain the returned preparation digest independently. Does not execute the device.', inputSchema: object({ taskId, expectation: object(expectation) }) },
  { name: 'reserve_adjudicated_task', description: 'Reserve a linked successor from an independently retained preparation receipt. Returns its task ID without device execution.', inputSchema: object({ taskId, receipt }) },
  { name: 'continue_adjudicated_task', description: 'Synchronously execute the reserved adjudicated successor after exact lease validation, environment cleanup and a fresh live checkpoint. Attached to this MCP process. Cancel using the reserved successor ID. For a crash after transfer but before any operation admission, supply transferRetryToken with the original receipt. A later boundary crash requires restart_adjudicated_task with a current lease token.', inputSchema: object({ taskId, receipt, transferRetryToken: uuid }, ['taskId', 'receipt']) },
  { name: 'restart_adjudicated_task', description: 'Restart an interrupted adjudicated successor only at a verified step boundary. Requires the independently retained original receipt, predecessor and successor IDs, current abandoned lease token, and a new live checkpoint. Creates a new successor; uncertain executing steps are rejected. Synchronous and attached to this MCP process.', inputSchema: { ...object({ predecessorTaskId: taskId, successorTaskId: taskId, receipt, leaseToken: uuid, checkpoint: { allOf: [{ $ref: '#/$defs/condition' }, { properties: { kind: { not: { enum: ['ui-changed', 'screen-stable'] } } } }] } }), $defs: definitions } },
];

export async function callAdjudicationTool(name: string, store: TaskStore, args: Record<string, unknown>, signal: AbortSignal) {
  const id = String(args.taskId);
  switch (name) {
    case 'restart_adjudicated_task': return restartAdjudicatedAndroidTask(store, String(args.predecessorTaskId), String(args.successorTaskId), args.receipt as SuccessorReservationReceipt, String(args.leaseToken), args.checkpoint, signal);
    case 'preview_uncertain_task': return previewUncertainTaskStep(store, id);
    case 'adjudicate_task': return recordUncertainStepAdjudication(store, id, args.decision as Parameters<typeof recordUncertainStepAdjudication>[2]);
    case 'prepare_adjudicated_task': return prepareAdjudicatedTaskContinuation(store, id, args.expectation as Parameters<typeof prepareAdjudicatedTaskContinuation>[2]);
    case 'reserve_adjudicated_task': return reserveAdjudicatedSuccessor(store, id, args.receipt as SuccessorReservationReceipt);
    case 'continue_adjudicated_task': return continueAdjudicatedAndroidTask(store, id, args.receipt as SuccessorReservationReceipt, { signal, ...(args.transferRetryToken !== undefined ? { transferRetryToken: args.transferRetryToken as string } : {}) });
    default: throw new Error('Unknown adjudication tool');
  }
}
