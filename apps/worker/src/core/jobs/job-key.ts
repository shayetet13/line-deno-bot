import {
  type JobKey,
  type MessageId,
  type RoomId,
  type RuleId,
  type SenderId,
  unsafeJobKey,
} from '@line-first/contracts';

const SEP = String.fromCharCode(0);

export interface JobKeyInput {
  /** Job id lifted from the message, when the game provides one. */
  explicitJobId?: string | undefined;
  sourceMessageId: MessageId;
  senderId: SenderId;
  roomId: RoomId;
  ruleId: RuleId;
}

/**
 * Identity of one job / one race (decision doc §5, Phases §8).
 *
 *  - explicit id present → `id:<jobId>`
 *  - otherwise           → `drv:` + sourceMessageId + sender + room + rule
 *
 * A different `sourceMessageId` is always a different job, so the same keyword
 * in a later round still produces a fresh key. NEVER key on the keyword alone.
 */
export function deriveJobKey(input: JobKeyInput): JobKey {
  const explicit = input.explicitJobId?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return unsafeJobKey(`id:${explicit}`);
  }
  const parts = [input.sourceMessageId, input.senderId, input.roomId, input.ruleId];
  return unsafeJobKey(`drv:${parts.join(SEP)}`);
}
