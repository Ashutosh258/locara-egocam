// Exponential backoff: 2s → 4s → 8s → 16s → 32s → 64s (capped).
// Adding ±10% jitter prevents a thundering herd if many workers fail at once
// and all retry on the same tick.

const BASE_MS = 2_000;
const MAX_MS = 64_000;
const JITTER_FACTOR = 0.1;

export function nextRetryDelayMs(attemptCount: number): number {
  // attemptCount is the number of attempts already made (before this failure).
  const expo = BASE_MS * Math.pow(2, attemptCount);
  const capped = Math.min(expo, MAX_MS);
  const jitter = capped * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.round(capped + jitter);
}

export function nextRetryAt(attemptCount: number): number {
  return Date.now() + nextRetryDelayMs(attemptCount);
}
