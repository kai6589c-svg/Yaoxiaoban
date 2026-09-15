let sequence = 0;

export const createId = (prefix: string, nowMs = Date.now()): string => {
  sequence = (sequence + 1) % 1_000_000;
  const random = Math.floor(Math.random() * 0x1000000)
    .toString(36)
    .padStart(5, "0");
  return `${prefix}_${nowMs.toString(36)}_${sequence.toString(36)}_${random}`;
};

export const createRequestId = (): string => createId("req");
