import { it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { Shell } from '../src/app/Shell.js';
import { parseNavCommand } from '../src/widgets/om-chat/index.js';
it('studio layout exposes navigation, canvas and right chat without starting transport', () => {
 const html = renderToStaticMarkup(createElement(Shell)); expect(html).toContain('aria-label="Features"'); expect(html).toContain('Workspace canvas'); expect(html).toContain('Assistant');
 expect(parseNavCommand({ command: 'app-control navigate --target campaigns' })).toBe('campaigns'); expect(parseNavCommand({ command: 'navigate design-systems' })).toBeNull();
});
