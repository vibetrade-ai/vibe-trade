import { describe, it, expect } from 'vitest';
import { toDhanInterval, parseDhanOrderStatus } from '../../dhan/index.js';

describe('toDhanInterval', () => {
  it.each([
    ['1m', '1'],
    ['5m', '5'],
    ['15m', '15'],
    ['25m', '25'],
    ['1h', '60'],
    ['1d', 'D'],
  ] as const)('%s → %s', (input, expected) => {
    expect(toDhanInterval(input)).toBe(expected);
  });
});

describe('parseDhanOrderStatus', () => {
  it.each([
    ['TRADED', 'FILLED'],
    ['PART_TRADED', 'PARTIALLY_FILLED'],
    ['PENDING', 'PENDING'],
    ['OPEN', 'OPEN'],
    ['TRANSIT', 'PENDING'],
    ['REJECTED', 'REJECTED'],
    ['CANCELLED', 'CANCELLED'],
    ['EXPIRED', 'CANCELLED'],
  ] as const)('%s → %s', (dhan, normalized) => {
    expect(parseDhanOrderStatus(dhan)).toBe(normalized);
  });

  it('is case-insensitive', () => {
    expect(parseDhanOrderStatus('traded')).toBe('FILLED');
    expect(parseDhanOrderStatus('Rejected')).toBe('REJECTED');
  });

  it('returns PENDING for unknown statuses', () => {
    expect(parseDhanOrderStatus('UNKNOWN_STATUS')).toBe('PENDING');
  });
});
