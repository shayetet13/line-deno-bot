/**
 * Inbound surface a message arrived on. Kept separate from the transport that
 * delivered it (push / normal-poll / dedicated-poll) — that is an
 * `InboundSource`, tracked in Phase 5.
 */
export const SURFACES = ['talk', 'square', 'oa'] as const;

export type Surface = (typeof SURFACES)[number];

export const isSurface = (value: string): value is Surface =>
  (SURFACES as readonly string[]).includes(value);

/** How the event reached us. The winner can change per message (Playbook §5.1). */
export const INBOUND_SOURCES = ['push', 'normal-poll', 'dedicated-poll'] as const;

export type InboundSource = (typeof INBOUND_SOURCES)[number];
