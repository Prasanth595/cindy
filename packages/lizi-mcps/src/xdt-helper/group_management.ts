import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

const id = z.string().uuid();
const revision = z.number().int().positive();
/** No caller-supplied group or acting identity: the Host binds both to the live turn. */
export const currentGroupAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update'), expectedRevision: revision, name: z.string().trim().min(1).max(40).optional(), topic: z.string().max(250).optional(), description: z.string().max(2000).optional(), responseMode: z.enum(['all', 'mentioned']).optional(), speakingMode: z.enum(['auto', 'sequential']).optional() }).strict(),
  z.object({ type: z.literal('member'), actorId: id, action: z.enum(['invite', 'remove', 'ban', 'unban', 'role']), role: z.enum(['admin', 'member']).optional() }).strict(),
  z.object({ type: z.literal('createInvite') }).strict(),
  z.object({ type: z.literal('revokeInvite'), link: z.string().min(1).max(2048) }).strict(),
  z.object({ type: z.literal('archive'), archived: z.boolean(), expectedRevision: revision }).strict(),
  z.object({ type: z.literal('execution'), executionId: id, action: z.literal('stop') }).strict(),
  z.object({ type: z.literal('plan'), planId: id, expectedRevision: revision, action: z.enum(['start', 'continue', 'retry', 'stop', 'dismiss', 'remove', 'reassign']), position: z.number().int().min(0).max(11).optional(), botId: id.optional() }).strict(),
  z.object({ type: z.literal('transfer'), actorId: id }).strict(),
  z.object({ type: z.literal('dissolve'), expectedRevision: revision }).strict(),
]);
export const currentGroupMutation = z.object({ operationId: id, action: currentGroupAction }).strict();
export type CurrentGroupMutation = z.infer<typeof currentGroupMutation>;
export type CurrentGroupRequest = { type: 'inspect' } | { type: 'manage'; mutation: CurrentGroupMutation };
export type CurrentGroupResult = { ok: true; [key: string]: unknown } | { ok: false; errorCode: string; message: string };
export type CurrentGroupCallback = (sessionId: string, request: CurrentGroupRequest) => Promise<CurrentGroupResult>;

export function registerCurrentGroupTools(registry: XdtHelperToolRegistry, deps: { getSessionContext(): LiziMcpSessionContext; execute: CurrentGroupCallback }) {
  const execute = async (request: CurrentGroupRequest) => {
    const sessionId = deps.getSessionContext().sessionId;
    if (!sessionId) return errorPayload('NO_GROUP_EXECUTION', 'An active teammate group turn is required.');
    const result = await deps.execute(sessionId, request);
    return result.ok ? okPayload(result) : errorPayload(result.errorCode, result.message);
  };
  registry.register({ name: 'get_current_group', category: 'bots',
    description: 'Read this group’s live name, topic, description, members, your own role, requester role, effective management permissions and current queue. Bound to the current executing teammate and group; never borrows your owner’s or another teammate’s role. Group roles do not grant private data or tools. Only available in an authorized live group execution on the hosting computer.',
    inputShape: {}, handler: async () => execute({ type: 'inspect' }) });
  registry.register({ name: 'manage_current_group', category: 'bots',
    description: 'Manage the current group as this executing teammate, when your current role allows it and the requester is your human owner. Guest management is unavailable until Chat Server can atomically authorize the requester; an admin guest cannot borrow your role. Read get_current_group first for actor IDs and revisions. Supports group information, members, invitation links, archive, execution stop, plan/queue controls, ownership transfer and dissolution. Transfer/dissolution require an explicit Host confirmation, even with Full Access. Never changes another teammate’s private access or tools. Use a unique operationId for a new operation; keep it for the same operation. GROUP_RESULT_UNKNOWN means it may have succeeded: query current state before deciding whether to retry; never blindly repeat removal, transfer or dissolution. Scope: this live group only, through the hosting computer’s Chat Server.',
    inputShape: currentGroupMutation.shape, handler: async (input: CurrentGroupMutation) => execute({ type: 'manage', mutation: currentGroupMutation.parse(input) }) });
}
