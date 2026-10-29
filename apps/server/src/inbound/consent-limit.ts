/** Host-owned rate limit for POST /consent (Jini `allow` hook). Fixed window, bounded key table. */
import { consentRateLimitKey } from '@jini-ai/cookie-consent/node';
import type { ClockPort } from '@open-marketing/contracts';

export type ConsentLimiter = { allow(required: { address: string | undefined }): boolean };
const MAX_KEYS = 4096;
/** Each address (IPv6 grouped by /64) may post `max` receipts per window; an unknown address shares one bucket.
 * The key table is bounded: expired windows are swept and, if still full, the request is denied.
 * @complexity O(1) amortized per call, O(MAX_KEYS) on sweep. */
export function createConsentLimiter(required: { clock: ClockPort }, optional?: { max?: number; windowMs?: number }): ConsentLimiter {
    const max = optional?.max ?? 20;
    const windowMs = optional?.windowMs ?? 60_000;
    const windows = new Map<string, { start: number; count: number }>();
    return { allow({ address }) {
        const now = required.clock.now({});
        const key = address ? consentRateLimitKey({ address }) : 'unknown';
        const current = windows.get(key);
        if (current && now - current.start < windowMs) { current.count += 1; return current.count <= max; }
        if (windows.size >= MAX_KEYS) for (const [name, item] of windows) if (now - item.start >= windowMs) windows.delete(name);
        if (windows.size >= MAX_KEYS) return false;
        windows.set(key, { start: now, count: 1 });
        return true;
    } };
}
