import { nextRetryDelayMs } from '../../src/upload/backoff';

// Seed Math.random for deterministic jitter in tests.
beforeEach(() => jest.spyOn(Math, 'random').mockReturnValue(0));
afterEach(() => jest.restoreAllMocks());

describe('exponential backoff', () => {
  // With jitter factor 0.1 and random = 0, jitter = 0.1 * base * (0 * 2 - 1) = -0.1 * base
  // So delay = base + jitter = base * 0.9

  const cases: Array<[number, number]> = [
    [0, Math.round(2_000 * 0.9)],   // attempt 0 → 2s base → 1800ms
    [1, Math.round(4_000 * 0.9)],   // attempt 1 → 4s base → 3600ms
    [2, Math.round(8_000 * 0.9)],   // attempt 2 → 8s base → 7200ms
    [3, Math.round(16_000 * 0.9)],  // attempt 3 → 16s base → 14400ms
    [4, Math.round(32_000 * 0.9)],  // attempt 4 → 32s base → 28800ms
    [5, Math.round(64_000 * 0.9)],  // attempt 5 → 64s (cap) → 57600ms
  ];

  it.each(cases)('attempt %i produces ~%ims delay', (attempt, expected) => {
    expect(nextRetryDelayMs(attempt)).toBe(expected);
  });

  it('caps at 64 seconds regardless of attempt count', () => {
    // With random = 0, delay = 64000 * 0.9 = 57600
    expect(nextRetryDelayMs(10)).toBe(Math.round(64_000 * 0.9));
    expect(nextRetryDelayMs(20)).toBe(Math.round(64_000 * 0.9));
  });

  it('delay increases with each attempt up to the cap', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // zero jitter at midpoint
    const delays = [0, 1, 2, 3, 4, 5].map(nextRetryDelayMs);
    for (let i = 0; i < delays.length - 1; i++) {
      if (delays[i] < 64_000) {
        expect(delays[i + 1]).toBeGreaterThanOrEqual(delays[i]);
      }
    }
  });
});
