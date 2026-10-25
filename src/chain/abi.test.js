// abi.js against the contracts as deployed (D7 on Base Sepolia, 2026-10-23, from contract commit 59151a65; its
// addresses: contract/satori/deployments/baseSepolia.json and config.js DEFAULTS), not against a local build, which
// runs ahead of the chain.
// - Offline: test/fixtures/abi-deployed.json, the deployed build's ABI for each function abi.js calls and each error
//   it decodes.
// - Online: the deployed code has every selector abi.js calls, and each view answers in the shape abi.js decodes
//   (read-only calls to the public RPC; skipped when it does not answer).
// At the next redeploy, build the deployed commit (`forge build` in contract/satori; or ABIs only, a second with
// solc's standard JSON, outputSelection abi; D7's came from the dapp's ABI files, contract/satori-ui/src/contracts,
// regenerated in the deploy's commit), then
//   ABI_SNAPSHOT=write npx vitest run src/chain/abi.test.js
// rewrites the snapshot from its out/ (ABI_OUT=<dir> for another build). Set `deploy` in it, review the diff, and
// fix abi.js where a test then fails; config.js DEFAULTS take the new addresses.
//
// PaymentChannels (channelsAbi) has its own snapshot, test/fixtures/abi-channels.json: every function, event and error
// of the build it was deployed from (its Hardhat artifact, whose code is the deployed code but for its immutables).
// It is immutable; a new version is a new address (a new CREATE2 salt). Then
//   ABI_SNAPSHOT=channels npx vitest run src/chain/abi.test.js
// rewrites it from the artifact (CHANNELS_ARTIFACT=<file> for another); set `deploy`, and config.js PAYMENT_CHANNELS.
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createPublicClient, decodeFunctionResult, encodeFunctionData, encodeFunctionResult, http, parseAbiItem, toFunctionSelector,
  toEventSelector, zeroAddress, zeroHash,
} from 'viem';
import * as abi from './abi.js';
import { DEFAULTS } from './config.js';

const SNAPSHOT = new URL('../../test/fixtures/abi-deployed.json', import.meta.url);
const OUT = process.env.ABI_OUT ?? '/code/Satori/contract/satori/out';
// abi.js's export → [the contract, its config.js address]
const CONTRACTS = {
  engineAbi: ['SatoriEngine', 'engine'], gamesAbi: ['SatoriGames', 'games'], registryAbi: ['SatoriRegistry', 'registry'],
  hubAbi: ['SatoriHub', 'hub'], rewardsAbi: ['SatoriRewards', 'rewards'], lensAbi: ['SatoriRewardsLens', 'lens'],
  tokenAbi: ['SatoriToken', 'token'], merkleAbi: ['SatoriMerkle', 'merkle'], airdropAbi: ['SatoriAirdrop', 'airdrop'],
  votingAbi: ['SatoriVoting', 'voting'],
};
// "function name(inputs) -> (outputs) mutability", types only
const t = (p) => (p.components ? `(${p.components.map(t).join(',')})${p.type.slice(5)}` : p.type);
const sig = (i) => `${i.type} ${i.name}(${(i.inputs ?? []).map(t)}) -> (${(i.outputs ?? []).map(t)})`
  + (i.type === 'function' ? ` ${i.stateMutability}` : '');
const of = (items, type) => items.filter((i) => i.type === type);

if (process.env.ABI_SNAPSHOT === 'write') {
  const read = (c) => JSON.parse(readFileSync(`${OUT}/${c}.sol/${c}.json`, 'utf8')).abi;
  const named = (items, type, ours) => of(items, type).filter((i) => ours.some((o) => o.name === i.name)).map(sig);
  const functions = Object.fromEntries(Object.entries(CONTRACTS).map(([name, [c]]) => [c, named(read(c), 'function', of(abi[name], 'function'))]));
  const raised = [...new Set(Object.values(CONTRACTS).flatMap(([c]) => named(read(c), 'error', of(abi.engineAbi, 'error'))))].sort();
  const { deploy } = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  writeFileSync(SNAPSHOT, `${JSON.stringify({ deploy, functions, errors: raised }, null, 2)}\n`);
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));

const CHANNELS_SNAPSHOT = new URL('../../test/fixtures/abi-channels.json', import.meta.url);
const CHANNELS_ARTIFACT = process.env.CHANNELS_ARTIFACT
  ?? '/code/Satori/contract/satori/artifacts/contracts/channels/PaymentChannels.sol/PaymentChannels.json';
// an event's signature with its indexed inputs: a wrong `indexed` decodes the wrong words
const evSig = (i) => `event ${i.name}(${i.inputs.map((p) => `${t(p)}${p.indexed ? ' indexed' : ''}`)})`;
if (process.env.ABI_SNAPSHOT === 'channels') {
  const all = JSON.parse(readFileSync(CHANNELS_ARTIFACT, 'utf8')).abi;
  const { deploy = '' } = existsSync(CHANNELS_SNAPSHOT) ? JSON.parse(readFileSync(CHANNELS_SNAPSHOT, 'utf8')) : {};
  writeFileSync(CHANNELS_SNAPSHOT, `${JSON.stringify({ deploy, functions: of(all, 'function').map(sig).sort(),
    events: of(all, 'event').map(evSig).sort(), errors: of(all, 'error').map(sig).sort() }, null, 2)}\n`);
}
const channels = JSON.parse(readFileSync(CHANNELS_SNAPSHOT, 'utf8'));

describe(`abi.js matches the deployed contracts (${snapshot.deploy})`, () => {
  for (const [name, [c]] of Object.entries(CONTRACTS)) {
    test(`${name}: every function as ${c} has it`, () => {
      for (const item of of(abi[name], 'function')) expect(snapshot.functions[c]).toContain(sig(item));
    });
  }
  test('every error the ABIs decode is one the contracts raise', () => {
    for (const item of of(abi.engineAbi, 'error')) expect(snapshot.errors).toContain(sig(item));
  });
});

describe(`channelsAbi matches PaymentChannels as deployed (${channels.deploy})`, () => {
  test('every function and event, as it has them (events with their indexed inputs)', () => {
    for (const item of of(abi.channelsAbi, 'function')) expect(channels.functions).toContain(sig(item));
    for (const item of of(abi.channelsAbi, 'event')) expect(channels.events).toContain(evSig(item));
  });
  test("every error of its own is one it raises (the token's, which a call bubbles up, apart)", () => {
    for (const e of abi.CHANNEL_ERRORS) expect(channels.errors).toContain(sig(parseAbiItem(e)));
  });
  test('what the market calls and watches is all there', () => {
    const names = (type) => of(abi.channelsAbi, type).map((i) => i.name).sort();
    expect(names('function')).toEqual(['CLOSE_GRACE_PERIOD', 'cancelClose', 'close', 'computeChannelId', 'getChannel', 'getTerms', 'open',
      'openWithPermit', 'requestClose', 'setGrace', 'setPayout', 'settle', 'settleMany', 'topUp', 'voucherDigest', 'withdraw', 'withdrawTo']);
    expect(names('event')).toEqual(['CloseCancelled', 'CloseRequested', 'Closed', 'GraceChanged', 'GraceProposed', 'Opened', 'PayoutSet',
      'Settled', 'ToppedUp', 'Withdrawn']);
  });
});

const BASE_SEPOLIA = '0x14a34'; // 84532
const online = await fetch(DEFAULTS.rpcUrl, {
  method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(3000),
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
}).then(async (r) => (await r.json()).result === BASE_SEPOLIA).catch(() => false);

describe.skipIf(!online)(`live: the deployed contracts on Base Sepolia (${DEFAULTS.rpcUrl}, read-only)`, () => {
  const client = createPublicClient({ transport: http(DEFAULTS.rpcUrl, { batch: true }) });
  const IMPLEMENTATION = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'; // EIP-1967's slot
  // the dispatcher pushes each selector: PUSH4 (0x63), or shorter for leading zero bytes
  const pushed = (selector) => {
    const s = selector.slice(2).replace(/^(00)+/, '');
    return (0x5f + s.length / 2).toString(16) + s;
  };
  const sample = (inputs) => inputs.map((p) => (p.type === 'address' ? zeroAddress : p.type === 'uint32' ? 1 : 0n)); // stream and game 1 exist
  for (const [name, [c, key]] of Object.entries(CONTRACTS)) {
    test(`${name}: ${c}'s code has each selector, and each view answers in abi.js's shape`, { timeout: 60_000 }, async () => {
      const address = DEFAULTS[key];
      const slot = await client.getStorageAt({ address, slot: IMPLEMENTATION });
      const code = await client.getCode({ address: BigInt(slot ?? 0) ? `0x${slot.slice(-40)}` : address });
      for (const f of of(abi[name], 'function')) {
        expect(code.includes(pushed(toFunctionSelector(f))), `${sig(f)}: its selector in the deployed code`).toBe(true);
        if (f.stateMutability !== 'view') continue;
        const call = { abi: abi[name], functionName: f.name };
        const { data } = await client.call({ to: address, data: encodeFunctionData({ ...call, args: sample(f.inputs) }) });
        const result = decodeFunctionResult({ ...call, data }); // ignores words past abi.js's outputs: re-encode to see them
        expect(encodeFunctionResult({ ...call, result }), `${sig(f)}: the answer's shape`).toBe(data);
      }
    });
  }
});

describe.skipIf(!online)(`live: PaymentChannels at ${DEFAULTS.channels} on Base Sepolia (read-only)`, () => {
  const client = createPublicClient({ transport: http(DEFAULTS.rpcUrl, { batch: true }) });
  const pushed = (selector) => { // as above: PUSH4, or shorter for leading zero bytes
    const s = selector.slice(2).replace(/^(00)+/, '');
    return (0x5f + s.length / 2).toString(16) + s;
  };
  test("its code has each function's selector and each event's topic; its views answer in channelsAbi's shape", { timeout: 60_000 }, async () => {
    const code = await client.getCode({ address: DEFAULTS.channels });
    for (const f of of(abi.channelsAbi, 'function')) expect(code.includes(pushed(toFunctionSelector(f))), sig(f)).toBe(true);
    for (const e of of(abi.channelsAbi, 'event')) expect(code.includes(toEventSelector(e).slice(2)), evSig(e)).toBe(true);
    const views = { getChannel: [zeroHash], computeChannelId: [zeroAddress, zeroAddress, zeroAddress, zeroAddress, zeroHash],
      voucherDigest: [zeroHash, 0n], CLOSE_GRACE_PERIOD: [] };
    for (const [functionName, args] of Object.entries(views)) {
      const call = { abi: abi.channelsAbi, functionName };
      const { data } = await client.call({ to: DEFAULTS.channels, data: encodeFunctionData({ ...call, args }) });
      expect(encodeFunctionResult({ ...call, result: decodeFunctionResult({ ...call, data }) }), functionName).toBe(data);
    }
    expect(await client.readContract({ address: DEFAULTS.channels, abi: abi.channelsAbi, functionName: 'CLOSE_GRACE_PERIOD' })).toBe(7n * 86400n);
  });
});

describe('selectors and calldata (Lite\'s and the brief\'s)', () => {
  test('DuplicatePrediction is 0xe372c20e (base_predict.py:132)', () => {
    expect(toFunctionSelector('DuplicatePrediction()')).toBe('0xe372c20e');
  });
  test('predictMultipleWithPayloads([(1, 0x01), (7, 0x02)]): the tuple[] Lite sends', () => {
    const data = encodeFunctionData({ abi: abi.engineAbi, functionName: 'predictMultipleWithPayloads',
      args: [[{ gameId: 1, payload: '0x01' }, { gameId: 7, payload: '0x02' }]] });
    expect(data.slice(0, 10)).toBe(toFunctionSelector('predictMultipleWithPayloads((uint32,bytes)[])'));
    expect(data).toContain('0100000000000000000000000000000000000000000000000000000000000000'); // 0x01, left-aligned
  });
});
