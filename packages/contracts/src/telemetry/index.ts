/** Local demo wire data only; strict variants exclude payloads, messages, and arbitrary metadata. */
import { z } from 'zod';
import { approvalChoiceSchema, studioNavigationTargetSchema } from '../api/index.js';
import { appErrorSchema, epochSchema, idSchema } from '../values/index.js';

const identifier = idSchema.regex(/^[A-Za-z0-9._:-]+$/);
const envelope = { at: epochSchema };
const card = { cardId: identifier, operationId: identifier };
const trace = { correlationId: identifier, traceId: identifier };
const durationMs = epochSchema;

/** Seven browser signals and one server completion. Time/duration are integer milliseconds.
 * @example captureEventSchema.safeParse({ kind: 'product', name: 'screen.viewed', at: 1000, screen: 'settings' });
 */
export const captureEventSchema = z.discriminatedUnion('name', [
    z.strictObject({ ...envelope, kind: z.literal('product'), name: z.literal('screen.viewed'), screen: studioNavigationTargetSchema }),
    z.strictObject({ ...envelope, ...card, kind: z.literal('product'), name: z.literal('approval.shown') }),
    z.strictObject({ ...envelope, ...card, ...trace, kind: z.literal('product'), name: z.literal('approval.clicked'), choice: approvalChoiceSchema, durationMs }),
    z.strictObject({ ...envelope, ...card, kind: z.literal('product'), name: z.literal('approval.expired'), durationMs }),
    z.strictObject({ ...envelope, kind: z.literal('error'), name: z.literal('approval.invalid_card'), errorCode: z.literal('invalid_card') }),
    z.strictObject({ ...envelope, ...card, ...trace, kind: z.literal('error'), name: z.literal('approval.submit_failed'), errorCode: z.enum([...appErrorSchema.shape.code.options, 'timeout']) }),
    z.strictObject({ ...envelope, kind: z.literal('error'), name: z.literal('studio.render_crash'), screen: studioNavigationTargetSchema, errorCode: z.literal('render_crash') }),
    z.strictObject({ ...envelope, ...trace, kind: z.literal('trace'), name: z.literal('approval.submit'), outcome: z.enum(['recorded', 'error']) }),
]).refine(event => new TextEncoder().encode(JSON.stringify(event)).byteLength <= 2048, 'Event exceeds 2 KiB');
export type CaptureEvent = z.infer<typeof captureEventSchema>;

/** Oldest first, bounded to the latest 100 disposable events; no cursor or persistence. */
export const recentEventsSchema = z.strictObject({ items: z.array(captureEventSchema).max(100) });
export type RecentEvents = z.infer<typeof recentEventsSchema>;
