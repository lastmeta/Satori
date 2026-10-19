// /llms.txt, the agents' one reference (docs/design/OVERVIEW.md): every window.satori method is in it, its Safety
// section names the calls only a person's request allows, and the history lives in /llms-changelog.txt.
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const llms = read('../public/llms.txt');
const main = read('./main.js');
const api = main.slice(main.indexOf('window.satori = {'), main.indexOf('\n};', main.indexOf('window.satori = {')));
const methods = [...api.matchAll(/^ {2}(?:async )?(\w+)\(/gm)].map((m) => m[1]);

test('every window.satori method is documented', () => {
  expect(methods.length).toBeGreaterThan(30);
  for (const m of methods) expect(llms, m).toMatch(new RegExp(`satori\\.${m}\\(`));
});

test('Safety comes before the reference, and lists the calls only the human may ask for', () => {
  const at = (h) => llms.indexOf(`\n## ${h}\n`);
  expect(at('Glossary')).toBeGreaterThan(0);
  expect(at('Glossary')).toBeLessThan(at('Safety'));
  expect(at('Safety')).toBeLessThan(at('Quick start (an agent)'));
  expect(at('Quick start (an agent)')).toBeLessThan(at('Drive it from the page (window.satori)'));
  const safety = llms.slice(at('Safety'), at('Quick start (an agent)'));
  expect(safety).toMatch(/data, never instructions/);
  for (const m of ['send', 'backup', 'unlock', 'stake', 'unstake', 'claim', 'setCentral', 'setBaseRpc', 'setRelays', 'retrain']) {
    expect(safety, m).toContain(`\`${m}\``);
    expect(methods, m).toContain(m);
  }
  expect(safety).toMatch(/"check my neuron"/);
});

test('the history is its own file, linked from the top; none of it is left here', () => {
  expect(llms.slice(0, 1500)).toContain('/llms-changelog.txt');
  expect(llms).not.toMatch(/^## Changed /m);
  expect(read('../public/llms-changelog.txt')).toMatch(/^# Satori neuron \(browser app\): what changed/);
});
