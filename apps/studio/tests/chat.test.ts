/** @vitest-environment jsdom */
import { it, expect } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Shell } from '../src/app/Shell.js';
it('global assistant opens and closes while unconnected chat cannot send', async () => {
 const user = userEvent.setup(); render(createElement(Shell));
 try {
  const button = screen.getByRole('button', { name: 'Assistant' });
  expect(button.getAttribute('aria-expanded')).toBe('false');
  await user.click(button); expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('Agent runtime is not connected.')).toBeDefined();
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true);
  await user.click(button); expect(button.getAttribute('aria-expanded')).toBe('false');
 } finally { cleanup(); }
});
