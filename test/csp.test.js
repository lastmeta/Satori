import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { CSP } from '../csp.js';

test('CSP matches the policy in docs/design/ui.md', () => {
  const doc = readFileSync(new URL('../docs/design/ui.md', import.meta.url), 'utf8');
  const block = doc.split('## Security')[1].split('```')[1];
  const policy = block.trim().split(/\s*\n\s*/).join(' ');
  expect(CSP).toBe(policy);
});
