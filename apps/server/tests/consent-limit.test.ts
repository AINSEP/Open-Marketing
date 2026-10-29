import { expect, it } from 'vitest';
import { createConsentLimiter } from '../src/inbound/consent-limit.js';

const clockAt = (state: { now: number }) => ({ now: () => state.now });

it('denies receipts over the per-address budget and resets after the window', () => {
    const state = { now: 1000 };
    const limiter = createConsentLimiter({ clock: clockAt(state) }, { max: 2, windowMs: 100 });
    const from = (address: string | undefined) => limiter.allow({ address });
    expect([from('203.0.113.1'), from('203.0.113.1'), from('203.0.113.1')]).toEqual([true, true, false]);
    expect(from('203.0.113.2')).toBe(true);
    state.now += 100;
    expect(from('203.0.113.1')).toBe(true);
});

it('groups one IPv6 /64 into a single budget and shares one bucket when the address is unknown', () => {
    const limiter = createConsentLimiter({ clock: clockAt({ now: 1 }) }, { max: 1 });
    expect(limiter.allow({ address: '2001:db8:1:1::1' })).toBe(true);
    expect(limiter.allow({ address: '2001:db8:1:1::2' })).toBe(false);
    expect(limiter.allow({ address: undefined })).toBe(true);
    expect(limiter.allow({ address: undefined })).toBe(false);
});
