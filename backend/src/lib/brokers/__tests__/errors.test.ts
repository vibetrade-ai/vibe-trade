import { describe, it, expect } from 'vitest';
import { BrokerError, BrokerAuthError } from '../errors.js';

describe('BrokerError', () => {
  it('is an Error with message and code', () => {
    const e = new BrokerError('bad request', 'E001');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('bad request');
    expect(e.code).toBe('E001');
  });

  it('has correct name property', () => {
    const e = new BrokerError('oops');
    expect(e.name).toBe('BrokerError');
  });

  it('code is optional', () => {
    const e = new BrokerError('no code');
    expect(e.code).toBeUndefined();
  });
});

describe('BrokerAuthError', () => {
  it('extends BrokerError', () => {
    const e = new BrokerAuthError('token expired');
    expect(e).toBeInstanceOf(BrokerError);
    expect(e).toBeInstanceOf(BrokerAuthError);
    expect(e).toBeInstanceOf(Error);
  });

  it('has AUTH_EXPIRED code', () => {
    const e = new BrokerAuthError();
    expect(e.code).toBe('AUTH_EXPIRED');
  });

  it('uses default message when none provided', () => {
    const e = new BrokerAuthError();
    expect(e.message).toContain('expired');
  });

  it('accepts custom message', () => {
    const e = new BrokerAuthError('custom message');
    expect(e.message).toBe('custom message');
  });
});
