import type { OwnerId, SenderId } from '@line-first/contracts';

/**
 * Who is allowed to start a job.
 *
 * Matching is by sender **id** and nothing else. A display name is attacker-
 * controlled: anyone can set theirs to the admin's, and in a busy room nobody
 * would notice. The acceptance table calls this out as its own case
 * ("ชื่อเหมือนแอดมินแต่คนละ ID | ไม่เข้าใจผิด"), so the interface deliberately has no
 * place to pass a name — there is nothing to get wrong at the call site.
 */
export interface SenderAllowlist {
  allows(ownerId: OwnerId, senderId: SenderId): boolean;
}

/** No restriction. The default, so a bot with no allowlist configured behaves
 * as it did before — but a room that needs one must say so explicitly. */
export const ALLOW_ANY_SENDER: SenderAllowlist = { allows: (): boolean => true };

/** Per-owner allowlist held as id sets. Lookup is O(1) and allocation-free, so
 * it is safe as the very first gate on the reply path. */
export class IdSenderAllowlist implements SenderAllowlist {
  readonly #byOwner = new Map<string, ReadonlySet<string>>();

  constructor(entries: Readonly<Record<string, readonly string[]>> = {}) {
    for (const [ownerId, senderIds] of Object.entries(entries)) {
      this.#byOwner.set(ownerId, new Set(senderIds));
    }
  }

  /** An owner with no entry is unrestricted; an owner with an empty list is
   * fully closed. The difference is deliberate — "not configured" and
   * "configured to allow nobody" must not collapse into each other. */
  allows(ownerId: OwnerId, senderId: SenderId): boolean {
    const allowed = this.#byOwner.get(String(ownerId));
    return allowed === undefined || allowed.has(String(senderId));
  }

  /** True when this owner has an explicit list. */
  isRestricted(ownerId: OwnerId): boolean {
    return this.#byOwner.has(String(ownerId));
  }
}
