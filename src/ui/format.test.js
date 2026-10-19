import { expect, test } from 'vitest';
import {
  fmtNum, fmtWhen, pickIndexes, registrationText, mismatchText, pollText, submitText, modelTitle,
  fmtCadence, shortKey, relayText, obsText, catalogMatch, predText,
  shortHash, amountText, fmtUtc, delegationText, claimableText, lockText, gasText, batchText, checkText, claimLine, rpcText, rpcTitle, stepText,
  storageText, playNote, modelText, historyText, daysText,
} from './format.js';

test('fmtNum', () => {
  expect(fmtNum(67123.456)).toBe('67,123.46');
  expect(fmtNum(100010)).toBe('100,010.00');
  expect(fmtNum(7)).toBe('7');
  expect(fmtNum(1.234567)).toBe('1.2346');
  expect(fmtNum(0.000123456)).toBe('0.000123');
  expect(fmtNum(null)).toBe('–');
  expect(fmtNum(NaN)).toBe('–');
});

test('fmtWhen: unix seconds → local month, day and time', () => {
  const at = new Date(2026, 9, 15, 14, 3, 9).getTime() / 1000;
  expect(fmtWhen(at)).toBe('Oct 15, 14:03');
  expect(fmtWhen(new Date(2026, 9, 16, 0, 5).getTime() / 1000)).toBe('Oct 16, 00:05');
  expect(fmtWhen(null)).toBe('–');
});

test('registrationText and mismatchText', () => {
  expect(registrationText(null)).toBe('Registering…');
  expect(registrationText({ ok: true, peer_id: 7 })).toBe('Yes · peer 7');
  expect(registrationText({ ok: false, error: 'Satori Network 409: taken' })).toBe('No: Satori Network 409: taken');
  expect(mismatchText(null)).toBe('');
  const [ours, theirs] = ['0x3a91ecc0dde5bfea5773345D5f61c894bc84B6E7', '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4'];
  expect(mismatchText({ ok: true, vault: ours, vault_base_address: ours, vaultMismatch: false })).toBe('');
  expect(mismatchText({ ok: true, vault: ours, vault_base_address: null, vaultMismatch: null })).toBe(''); // central does not say: unknown
  expect(mismatchText({ ok: true, vault: ours, vault_base_address: theirs, vaultMismatch: 'other' }))
    .toBe(`Vault mismatch: the Satori Network pays this vault's rewards to a different Base address, ${theirs}, not this vault's ${ours}.`);
  expect(mismatchText({ ok: true, vault: ours, vault_base_address: null, vaultMismatch: 'none' }))
    .toBe("Vault mismatch: the Satori Network kept no vault for this identity, so it has no Base address to pay this neuron's rewards to"
      + ' (this vault may be registered to another neuron).');
});

test('pollText and submitText', () => {
  const at = new Date(2026, 9, 15, 14, 3).getTime() / 1000;
  expect(pollText(null)).toBe('Not yet');
  expect(pollText({ at, streams: 83, new: 80, predicted: 80 })).toBe('Oct 15, 14:03 · 83 streams, 80 new, 80 predicted');
  expect(pollText({ at, error: 'Satori Network timed out (15 s)' })).toBe('Oct 15, 14:03 · failed: Satori Network timed out (15 s)');
  expect(submitText(null)).toBe('Not yet');
  expect(submitText({ at, total_submitted: 80, successful: 80, failed: 0 })).toBe('Oct 15, 14:03 · 80 of 80 accepted');
  expect(submitText({ at, total_submitted: 2, successful: 0, failed: 2, errors: ['x'] }))
    .toBe('Oct 15, 14:03 · 0 of 2 accepted; kept for the next poll');
  expect(submitText({ at, error: 'Satori Network 500: boom' })).toBe('Oct 15, 14:03 · failed: Satori Network 500: boom; kept for the next poll');
});

test('pickIndexes', () => {
  const ix = pickIndexes(3, 24);
  expect(ix).toHaveLength(3);
  expect(new Set(ix).size).toBe(3);
  expect(ix.every((i) => i >= 0 && i < 24)).toBe(true);
  expect([...ix].sort((a, b) => a - b)).toEqual(ix);
});

test('modelTitle: the engine model in a few words (the Streams table hover)', () => {
  expect(modelTitle({ model: 'bar1', phi: -0.12345, weight: 0.8 })).toBe('Bayesian AR(1) on 12 h returns · φ −0.123 · weight 0.8');
  expect(modelTitle({ model: 'bar1', phi: 0, weight: 1 })).toBe('Bayesian AR(1) on 12 h returns · φ 0 · weight 1');
  expect(modelTitle({ model: 'naive' }))
    .toBe('the last value: bar1 needs an observation every 12 h (6 lag pairs of back-to-back 12 h buckets)');
  expect(modelTitle({ model: 'ols-20' })).toBe('ols-20');
  expect(modelTitle({ model: null })).toBe('');
});

test('fmtCadence', () => {
  expect([900, 1800, 3600, 7200, 86400, 2592000, 45, 90, null].map(fmtCadence))
    .toEqual(['15 min', '30 min', '1 h', '2 h', '1 d', '30 d', '45 s', '90 s', 'irregular']);
});

test('shortKey', () => {
  expect(shortKey('e5e6ce948344b1e0178f9ccf49fcb499b4b4f00fc09c7637535ee82fc7bf503d')).toBe('e5e6ce94…503d');
  expect(shortKey('')).toBe('');
});

test('daysText: the day strip\'s summary counts only the days since the neuron began', () => {
  const days = (codes) => codes.map((code) => ({ code }));
  expect(daysText(days(['full', 'closed', 'part', 'full']))).toBe('2 of 4 full days');
  expect(daysText(days([...Array(13).fill('before'), 'full']))).toBe('1 full day'); // a new neuron's first day
  expect(daysText(days([...Array(13).fill('before'), 'closed']))).toBe('0 full days');
  expect(daysText(days([...Array(11).fill('before'), 'full', 'error', 'full']))).toBe('2 of 3 full days');
  expect(daysText([])).toBe('');
});

test('relayText: the state in a word, and read only', () => {
  expect(relayText({ state: 'open', write: true })).toBe('Connected');
  expect(relayText({ state: 'open', write: false })).toBe('Connected · read only');
  expect(relayText({ state: 'connecting', write: true })).toBe('Connecting…');
  expect(relayText({ state: 'closed', write: true, error: 'closed (1006)' })).toBe('Disconnected (closed (1006)); retrying');
  expect(relayText({ state: 'blocked', write: false, error: 'ws:// cannot be opened from an https page' }))
    .toBe('Blocked: ws:// cannot be opened from an https page');
});

test('obsText: a relay value as a number when it has one, as predText; else as sent (a dict as JSON)', () => {
  expect(obsText({ raw: '82234', value: 82234 })).toBe('82,234.00');
  expect(obsText({ raw: '97.16251735526325', value: 97.16251735526325 })).toBe(predText('97.16251735526325'));
  expect(obsText({ raw: { value: 5, unit: 'C' }, value: 5 })).toBe('5');
  expect(obsText({ raw: { raw: '1', unit: 'tick' }, value: null })).toBe('{"raw":"1","unit":"tick"}');
  expect(obsText(null)).toBe('–');
});

test('predText: a published value as a number when it is one (the exact string is in the title)', () => {
  expect(predText('97.16251735526325')).toBe('97.1625');
  expect(predText('82109.0')).toBe('82,109.00');
  expect(predText('abc')).toBe('abc');
  expect(predText('{"raw": "1"}')).toBe('{"raw": "1"}');
  expect(predText(null)).toBe('–');
});

test('catalogMatch: name, stream, description or tags, any case', () => {
  const s = { stream_name: 'btc-usd-price', name: 'Bitcoin USD Price', description: 'From CoinGecko', tags: ['crypto'] };
  for (const q of ['', 'BTC', 'bitcoin usd', 'coingecko', 'CRYPTO']) expect(catalogMatch(s, q), q).toBe(true);
  expect(catalogMatch(s, 'eth')).toBe(false);
});

test('Base: amounts, the stake, the transfer rule (sent from round N + 1 at 00:00 UTC)', () => {
  expect(amountText('100', 'SATORI')).toBe('100 SATORI');
  expect(amountText('0.000123456', 'ETH')).toBe('0.000123 ETH');
  expect(amountText(null, 'ETH')).toBe('–');
  expect(fmtUtc(20743 * 86400)).toBe('Oct 17, 00:00 UTC');
  const v = { identity: { power: '100' }, vault: { staked: 'identity', stakedWith: '0xI' } };
  expect(delegationText(v)).toBe('Staked: 100 SATORI with this neuron');
  expect(delegationText({ ...v, vault: { ...v.vault, inSync: false } })).toBe('Staked: 100 SATORI with this neuron · out of sync');
  // what can be claimed, part by part: the Satori Network's drop in plain words; unknown (a central without the route) is '–', not 0
  expect(claimableText({ rewards: '3', drop: '3.61850955', airdrop: '0' })).toBe('3 SATORI rewards · 3.6185 SATORI from the Satori Network · 0 SATORI airdrop');
  expect(claimableText({ rewards: '0', drop: null, airdrop: '0' })).toBe('0 SATORI rewards · – from the Satori Network · 0 SATORI airdrop');
  expect(delegationText({ ...v, vault: { staked: 'none' } })).toBe('Not staked');
  expect(delegationText({ ...v, vault: { staked: 'other', stakedWith: '0xO' } })).toBe('Staked with 0xO, not this neuron');
  expect(delegationText(null)).toBe('–');
  expect(lockText({ locked: false })).toBe('Free to send');
  expect(lockText({ locked: true, indefinite: true })).toBe("Staked SATORI can't be sent until you unstake");
  expect(lockText({ locked: true, indefinite: false, untilRound: 20742, freeAt: 20743 * 86400 }))
    .toBe('SATORI can be sent from Oct 17, 00:00 UTC (round 20743)');
});

test('Base: gas, the last batch, the check, a claim', () => {
  expect(gasText({ eth: '0.1', batchesLeft: 33 })).toBe('0.1 ETH · about 33 daily batches');
  expect(gasText({ eth: '0.1', batchesLeft: 1 })).toBe('0.1 ETH · about 1 daily batch');
  expect(gasText({ eth: '9', batchesLeft: 5000 })).toBe('9 ETH · about 1,000+ daily batches');
  expect(gasText({ eth: null })).toBe('–');
  const at = new Date(2026, 9, 15, 9, 0).getTime() / 1000;
  expect(batchText(null)).toBe('None yet');
  expect(batchText({ round: 20741, at, games: [{ gameId: 1, direction: 2 }, { gameId: 3, direction: 1 }],
    dropped: [{ gameId: 4, error: 'StaleValue' }] })).toBe('Round 20741 · Oct 15, 09:00 · game 1 ↓, game 3 ↑ · left out: game 4 (StaleValue)');
  expect(checkText(null, null)).toBe('Not yet');
  expect(checkText({ round: 20741, sent: {} }, at)).toBe('sent round 20741 · next Oct 15, 09:00');
  expect(checkText({ skipped: 'already predicted this round' }, null)).toBe('already predicted this round');
  expect(checkText({ error: 'boom' }, null)).toBe('failed: boom');
  expect(shortHash('0x' + 'ab'.repeat(32))).toBe('0xabab…abab');
  expect(claimLine('Rewards', { hash: '0x' + 'ab'.repeat(32), amount: '3' })).toBe('Rewards: claimed 3 SATORI (0xabab…abab)');
  expect(claimLine('Merkle', { skipped: 'this vault is not in the current drop' })).toBe('Merkle: this vault is not in the current drop');
  expect(claimLine('Airdrop', { error: 'reverted: NothingToClaim' })).toBe('Airdrop: failed: reverted: NothingToClaim');
});

test('modelTitle: bar1d, the AR(1) on changes', () => {
  expect(modelTitle({ model: 'bar1d', phi: 0.51234, weight: 0.75 })).toBe('Bayesian AR(1) on 12 h changes (a series with values ≤ 0) · φ 0.512 · weight 0.75');
});

test('rpcText, rpcTitle, stepText: plain words on the card, the detail in the hover', () => {
  const fork = { rpc: ['/rpc'], rpcSetting: '', localFork: true };
  expect(rpcText(fork)).toBe('Local test chain (a fork of Base Sepolia)');
  expect(rpcTitle(fork)).toBe('/rpc → 127.0.0.1:8545 (node scripts/fork.mjs start)');
  const build = { rpc: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'], rpcSetting: '', localFork: false };
  expect(rpcText(build)).toBe('sepolia.base.org, then base-sepolia-rpc.publicnode.com (the default)');
  expect(rpcText({ rpc: ['https://mine.example/rpc'], rpcSetting: 'https://mine.example/rpc', localFork: false })).toBe('mine.example');
  expect(rpcText({ rpc: [], rpcSetting: '', localFork: false })).toBe('–');
  expect(stepText('setPredictorFee(0)')).toBe('Identity: fee to 0');
  expect(stepText('delegatePredictionPower(identity)')).toBe('Vault: stakes with this neuron');
  expect(stepText('delegatePredictionPower(0x0)')).toBe('Vault: unstakes');
  expect(stepText('somethingNew()')).toBe('somethingNew()');
});

test('storageText: kept or not (docs/design/pwa.md), and the usage of the quota when the browser says', () => {
  expect(storageText(null)).toBe('Storage: …');
  expect(storageText({ persisted: true, usage: 41_234_567, quota: 299_000_000_000 })).toBe('Storage: kept · 41 MB of 299 GB used');
  expect(storageText({ persisted: false, usage: 512_000, quota: 1_200_000_000 }))
    .toBe('Storage: the browser may clear it; install Satori or back up your words · 0.5 MB of 1.2 GB used');
  expect(storageText({ persisted: true, usage: null, quota: null })).toBe('Storage: kept');
});

test('playNote: the neuron plays on-chain automatically, Satori Daily by hand, never both with one vault (docs/design/base.md)', () => {
  const text = (d) => playNote(d)?.join('Satori Daily');
  expect(text('identity')).toBe("Your SATORI is staked with this neuron, so it can't also play Satori Daily by hand. "
    + 'Unstake to play manually.');
  expect(text('none')).toBe('Stake with this neuron to let it predict every round, or play Satori Daily by hand.');
  expect(playNote('other')).toBe(null); // staked elsewhere: the Staking line says with whom
  expect(playNote(null)).toBe(null); // before the first chain read
});

const SPEC = JSON.stringify({ companions: ['u-eth', 'u-gold'], lambda1: 0.2, lambda2: 0.5 });
const NAMES = new Map([['u-btc', 'bitcoin'], ['u-eth', 'eth'], ['u-gold', 'gold']]);

test('modelText: the model and its spec\'s companions (the Streams table\'s Model column)', () => {
  expect(modelText({ model: 'bvar', spec: SPEC }, NAMES)).toBe('bvar · +eth +gold');
  expect(modelText({ model: 'naive', spec: SPEC }, NAMES)).toBe('naive · spec +eth +gold'); // the spec waits for aligned rows
  expect(modelText({ model: 'bar1', spec: JSON.stringify({ companions: ['u-gone'], lambda1: 0.2, lambda2: 0.5 }) }, NAMES))
    .toBe('bar1 · spec +u-gone');
  expect(modelText({ model: 'bar1', spec: null }, NAMES)).toBe('bar1');
  expect(modelText({ model: null, spec: SPEC }, NAMES)).toBe('–');
});

test('modelTitle: bvar with its spec, score and generation; a fallback says what its spec waits for', () => {
  expect(modelTitle({ model: 'bvar', spec: SPEC, phi: 0.031, weight: 0.97, score: 0.012345, generation: 14, accepted: 3 }, NAMES))
    .toBe('Bayesian VAR(1) on 12 h steps of this stream with eth, gold · λ1 0.2 · λ2 0.5 · own φ 0.031 · weight 0.97'
      + ' · generation 14, 3 kept · score 1.23% (median 24 h error, last 28 origins)');
  expect(modelTitle({ model: 'naive', spec: SPEC, score: null, generation: 0, accepted: 0 }, NAMES))
    .toBe('the last value: bar1 needs an observation every 12 h (6 lag pairs of back-to-back 12 h buckets)'
      + ' · its spec: bvar with eth, gold, λ1 0.2, λ2 0.5, generation 0, until it has 8 aligned 12 h rows');
});

test('historyText: the Satori Network\'s history for our streams (its card on Streams)', () => {
  const at = Date.UTC(2026, 9, 16, 9, 30) / 1000;
  expect(historyText(null)).toBe('Not yet');
  expect(historyText({ at, streams: 83, rows: 81234, left: 0, error: null, retryAt: null, needed: 0 }))
    .toBe(`${fmtWhen(at)} · 83 streams, 81,234 rows`);
  expect(historyText({ at, streams: 0, rows: 0, left: 83, error: 'Satori Network 404: Not Found', retryAt: at + 86400, needed: 83 }))
    .toBe(`No history from the Satori Network yet (Satori Network 404: Not Found); next try ${fmtWhen(at + 86400)}`);
  expect(historyText({ at, streams: 2, rows: 10, left: 3, error: 'Satori Network 500: boom', retryAt: null, needed: 3 }))
    .toBe(`${fmtWhen(at)} · 2 streams, 10 rows · failed: Satori Network 500: boom; 3 streams wait for the next poll`);
  expect(historyText({ needed: 5 })).toBe('5 streams wait for the next poll');
});
