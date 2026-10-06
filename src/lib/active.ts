import type { Snapshot } from '../../packages/contracts/src';

/**
 * Which conversation a window shows. Both the main window and the bubble derive
 * it from the shared snapshot, so a message sent in the bubble puts the same
 * conversation in front of the main window without any window-local selection
 * being treated as shared state. Local browsing in the main window stays local.
 */
export function pickActiveConversationId(
  snapshot: Snapshot,
): string | undefined {
  const latest = snapshot.events.reduce<{ id: string; at: string } | null>(
    (best, event) => {
      if (!best || event.createdAt > best.at)
        return { id: event.conversationId, at: event.createdAt };
      return best;
    },
    null,
  );
  if (latest)
    return snapshot.conversations.some((item) => item.id === latest.id)
      ? latest.id
      : undefined;
  return snapshot.conversations.at(-1)?.id;
}
