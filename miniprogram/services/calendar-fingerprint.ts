/**
 * Identity for one repeat-calendar slot. Presentation text and the rolling
 * 90-day write window are deliberately excluded: changing privacy wording or
 * retrying tomorrow must not create the same schedule slot a second time.
 * A plan edit creates a new immutable plan id, so the new version naturally
 * receives a different fingerprint.
 */
export const calendarFingerprint = (args: {
  medicationId: string;
  planId: string;
  weekday: number | null;
  time: string;
}): string =>
  [
    args.medicationId,
    args.planId,
    args.weekday === null ? "daily" : `weekday-${args.weekday}`,
    args.time,
  ].join("|");
