import { expect, it } from 'vitest';
import { assistantContextSchema, assistantRunRequestSchema, chatAttachmentSchema } from '../src/index.js';

const ref = { path: 'media-id', name: 'image.png', kind: 'image', size: 1048576 };
const settings = { mode: 'model', model: 'fixture-model', connectionId: 'connection' };

it('keeps text-only requests compatible and bounds attachment counts and sizes', () => {
 expect(assistantRunRequestSchema.parse({ prompt: 'Hello' })).toEqual({ prompt: 'Hello' });
 expect(assistantRunRequestSchema.safeParse({ prompt: 'Look', attachments: Array(4).fill(ref) }).success).toBe(true);
 expect(assistantRunRequestSchema.safeParse({ prompt: 'Look', attachments: Array(5).fill(ref) }).success).toBe(false);
 for (const size of [0, -1, 1.5, 1048577]) expect(chatAttachmentSchema.safeParse({ ...ref, size }).success).toBe(false);
});
it('rejects unsafe names and non-image references', () => {
 for (const name of ['', 'x'.repeat(256), 'a/b', 'a\\b', 'a\0b', 'a\nb', 'a\x7fb']) {
  expect(chatAttachmentSchema.safeParse({ ...ref, name }).success).toBe(false);
 }
 expect(chatAttachmentSchema.safeParse({ ...ref, name: '商品.png' }).success).toBe(true);
 expect(chatAttachmentSchema.safeParse({ ...ref, kind: 'file' }).success).toBe(false);
});
it('allows bounded current-turn image data while preserving the text context limit', () => {
 const image = { mimeType: 'image/png', data: 'AAAA'.repeat(349526) };
 expect(assistantContextSchema.safeParse({ settings, messages: [], attachments: [ref], images: Array(4).fill(image) }).success).toBe(true);
 for (const images of [[{ ...image, data: image.data + 'AAAA' }], Array(5).fill(image), [{ ...image, data: '!!!!' }], [{ ...image, mimeType: 'image/gif' }]]) {
  expect(assistantContextSchema.safeParse({ settings, messages: [], images }).success).toBe(false);
 }
 expect(assistantContextSchema.safeParse({ settings, messages: Array(3).fill({ id: 'm', role: 'user', text: 'x'.repeat(65536) }) }).success).toBe(false);
});
