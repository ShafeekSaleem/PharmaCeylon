import type { JournalSync } from "./ipc-contract";

type Holds = NonNullable<JournalSync["pause"]>["holds"];

/**
 * Why an outage's synchronisation is still waiting on offline notes and card payments, in the
 * words used at the counter. Empty when nothing of that kind is holding it.
 */
export function drainHoldSentences(holds: Holds): string[] {
  const out: string[] = [];
  if (holds.cards > 0)
    out.push(
      holds.cards === 1
        ? "A card payment from the outage is not settled yet. Open This counter, find what the card machine did and record it."
        : `${holds.cards} card payments from the outage are not settled yet. Open This counter, find what the card machine did for each and record it.`,
    );
  const waiting = holds.records - holds.refused;
  if (waiting > 0)
    out.push(
      waiting === 1
        ? "A note or card record is still on its way to the server."
        : `${waiting} notes or card records are still on their way to the server.`,
    );
  if (holds.refused > 0)
    out.push(
      holds.refused === 1
        ? "The server turned down one note or card record. It will not clear by itself: contact support."
        : `The server turned down ${holds.refused} notes or card records. They will not clear by themselves: contact support.`,
    );
  return out;
}
