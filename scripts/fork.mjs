#!/usr/bin/env node
// A local fork of Base Sepolia for the Base card (docs/design/base.md#the-local-fork-dev).
// The dev server proxies /rpc to 127.0.0.1:8545, its default Base RPC, so by
// default a dev checkout does not send to a public chain (a saved RPC replaces
// the default). anvil: ~/.foundry/bin/anvil (or $ANVIL). The deployer
// (0x9d31…8817, D6's admin, root publisher and airdrop authority, ~519 SATORI)
// is impersonated. Commands: USAGE below (node scripts/fork.mjs --help).
import { spawn } from 'node:child_process';
import { openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, http, keccak256, concat,
  parseAbi, parseEther, encodePacked,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { DEFAULTS } from '../src/chain/config.js';
import { HOOK_GAS } from '../src/chain/index.js';

export const DEPLOYER = '0x9d3109b8A045D63056Aa5C1d2c883F3F9fA18817';

const USAGE = `Usage: node scripts/fork.mjs <command> [args] [--port 8545]
A local anvil fork of Base Sepolia; the dev server's /rpc goes to 127.0.0.1:8545.

  start                          start anvil in the background (--fork-url https://sepolia.base.org, 2 s blocks)
  stop                           stop it
  fund <0x…> [<0x…> …] [--eth 0.1] [--satori N]
                                 set each address's ETH (0.1 by default); with --satori, also send each N SATORI
                                 from the deployer (none without it; the deployer holds ~519)
  airdrop <0x…> <SATORI>         load an airdrop allocation for the address
  merkle <0x…> <SATORI>          set a merkle root with the address; prints the proof JSON a (stub) central serves
  advance [days]                 move chain time forward (1 day by default) and mine a block
  predict [up|down]              the deployer predicts the default game (moves its next value)
  stream [name]                  anyone's new stream (a 0.001 SATORI burn) with one value: its game has no voting weight
  grief <0x…>                    the token-hook bug: 1 wei of SATORI to the address with the bare gas estimate, as any wallet
                                 sends it; a staked wallet's stake is then out of sync and it can't unstake
                                 (docs/issues/token-hook-gas-estimate.md)

Fund a neuron to predict on Base (its prediction power is the wallet's SATORI, staked with this neuron):
  node scripts/fork.mjs fund <alias 0x…>               gas for the daily batch
  node scripts/fork.mjs fund <wallet 0x…> --satori 100     gas for Stake, and SATORI to stake
  then in the page: await satori.unlock(passphrase); await satori.stake(); await satori.predictBase()
(both 0x addresses: satori.status().base.alias.address and .wallet.address)`;
const FORK_URL = 'https://sepolia.base.org';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const abi = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error Locked()', 'error Unauthorized()', 'error DuplicateRecipient()', 'error AlreadyPredicted()',
  'function loadAirdropBatch(address[] recipients, uint256[] amounts)',
  'function setMerkleRoot(bytes32 newRoot)',
  'struct Request { uint32 gameId; bytes payload; }',
  'function predictMultipleWithPayloads(Request[] requests)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function createSimpleDataStream(string name, address provider, uint24 minCadenceMinutes) returns (uint32)',
  'function setValues(uint32[] streamIds, int232[] values) returns (uint256)',
  'function getAllDataStreams() view returns (uint32[])',
  'function binaryGameByStream(uint32) view returns (uint32)',
]);

export function clients(rpc) {
  const transport = http(rpc);
  return {
    test: createTestClient({ mode: 'anvil', chain: baseSepolia, transport }),
    pub: createPublicClient({ chain: baseSepolia, transport }),
    deployer: createWalletClient({ account: DEPLOYER, chain: baseSepolia, transport }),
  };
}

async function asDeployer(rpc, address, functionName, args) {
  const { test, pub, deployer } = clients(rpc);
  await test.impersonateAccount({ address: DEPLOYER });
  await test.setBalance({ address: DEPLOYER, value: parseEther('10') }); // anvil's default gas limit is the block's (1.2e9)
  const { request } = await pub.simulateContract({ account: DEPLOYER, address, abi, functionName, args }); // a revert says why
  const gas = await pub.estimateContractGas({ account: DEPLOYER, address, abi, functionName, args });
  const hash = await deployer.writeContract({ ...request, gas: gas + HOOK_GAS }); // SATORI to a staked wallet: the hook needs it
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  if (r.status !== 'success') throw new Error(`${functionName} failed (${hash})`);
  return hash;
}

/** ETH (anvil_setBalance) and SATORI (from the deployer) to each address. */
export async function fund(rpc, addresses, { eth = '0.1', satori = '0' } = {}) {
  const { test } = clients(rpc);
  for (const address of addresses) {
    await test.setBalance({ address, value: parseEther(String(eth)) });
    if (Number(satori) > 0) await asDeployer(rpc, DEFAULTS.token, 'transfer', [address, parseEther(String(satori))]);
  }
}

export const airdrop = (rpc, address, satori) =>
  asDeployer(rpc, DEFAULTS.airdrop, 'loadAirdropBatch', [[address], [parseEther(String(satori))]]);

// SatoriMerkle's leaf: keccak256(keccak256(abi.encode(account, amount))) (SatoriMerkle.sol:185-188);
// pairs hashed sorted, as OpenZeppelin's MerkleProof (contract/satori/scripts/merkle-drop.js).
const leafOf = (account, amount) =>
  keccak256(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account, amount])));
const pair = (a, b) => keccak256(concat(a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]));

/** A root over `address` and a filler entry; → central's /merkle/proof shape { root, address, amountWei, amount, proof }. */
export async function merkle(rpc, address, satori) {
  const amountWei = parseEther(String(satori));
  const mine = leafOf(address, amountWei);
  const other = leafOf('0x000000000000000000000000000000000000dEaD', 1n);
  const root = pair(mine, other);
  await asDeployer(rpc, DEFAULTS.merkle, 'setMerkleRoot', [root]);
  return { root, address, amountWei: amountWei.toString(), amount: Number(satori), proof: [other] };
}

/** Chain time forward by `days`, then a block. */
export async function advance(rpc, days = 1) {
  const { test } = clients(rpc);
  await test.increaseTime({ seconds: Math.round(Number(days) * 86400) });
  await test.mine({ blocks: 1 });
}

/** The deployer predicts the default game (stream 1): its SATORI deployed this round moves the next round's value. */
export const predict = (rpc, dir = 'up') =>
  asDeployer(rpc, DEFAULTS.engine, 'predictMultipleWithPayloads', [[{ gameId: 1, payload: encodePacked(['uint8'], [dir === 'down' ? 2 : 1]) }]]);

/**
 * The token-hook bug (docs/issues/token-hook-gas-estimate.md): 1 wei of SATORI from the deployer to `address`, sent with
 * the node's bare gas estimate (no HOOK_GAS), as any wallet or library sends it. The hook runs out of gas and is
 * swallowed, so a staked address's SATORI is no longer all in its delegate's power. → { hash, events }
 */
export async function grief(rpc, address) {
  const { test, pub, deployer } = clients(rpc);
  await test.impersonateAccount({ address: DEPLOYER });
  await test.setBalance({ address: DEPLOYER, value: parseEther('10') });
  const call = { account: DEPLOYER, address: DEFAULTS.token, abi, functionName: 'transfer', args: [address, 1n] };
  const { request } = await pub.simulateContract(call);
  const gas = await pub.estimateContractGas(call);
  const hash = await deployer.writeContract({ ...request, gas });
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  if (r.status !== 'success') throw new Error(`transfer failed (${hash})`);
  const events = r.logs.map((l) => ({ address: l.address, topic: l.topics[0] }))
    .filter((l) => [HOOK_FAILED, CHILD_SYNC_FAILED].includes(l.topic)).map((l) => (l.topic === HOOK_FAILED ? 'TransferHookFailed' : 'ChildSyncFailed'));
  return { hash, gas: Number(gas), events };
}
const HOOK_FAILED = keccak256(new TextEncoder().encode('TransferHookFailed(address,address,uint256)'));
const CHILD_SYNC_FAILED = keccak256(new TextEncoder().encode('ChildSyncFailed(address,address,address,uint256)'));

/** A new stream from the deployer (hub.createSimpleDataStream burns 0.001 SATORI) with one value. → { streamId, gameId } */
export async function stream(rpc, name) {
  await asDeployer(rpc, DEFAULTS.token, 'approve', [DEFAULTS.hub, parseEther('1')]);
  await asDeployer(rpc, DEFAULTS.hub, 'createSimpleDataStream', [name, DEPLOYER, 60]);
  const { pub } = clients(rpc);
  const streamId = (await pub.readContract({ address: DEFAULTS.registry, abi, functionName: 'getAllDataStreams' })).at(-1);
  await asDeployer(rpc, DEFAULTS.registry, 'setValues', [[streamId], [1000n]]);
  const gameId = await pub.readContract({ address: DEFAULTS.games, abi, functionName: 'binaryGameByStream', args: [streamId] });
  return { streamId, gameId };
}

async function answering(rpc, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await clients(rpc).pub.getChainId()) === 84532) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** anvil in the background (it outlives this script), logging to .fork.<port>.log; its pid in .fork.<port>.pid. */
export async function start(port = 8545) {
  const rpc = `http://127.0.0.1:${port}`;
  if (await answering(rpc, 1)) return { rpc, running: true };
  const anvil = process.env.ANVIL ?? `${homedir()}/.foundry/bin/anvil`;
  const out = openSync(`${ROOT}.fork.${port}.log`, 'a');
  const child = spawn(anvil, ['--fork-url', FORK_URL, '--host', '127.0.0.1', '--port', String(port), '--block-time', '2'],
    { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  writeFileSync(`${ROOT}.fork.${port}.pid`, String(child.pid));
  if (!(await answering(rpc))) throw new Error(`anvil did not answer on ${rpc} (see .fork.${port}.log)`);
  return { rpc, pid: child.pid };
}

function stop(port) {
  const file = `${ROOT}.fork.${port}.pid`;
  const pid = Number(readFileSync(file, 'utf8'));
  process.kill(pid);
  rmSync(file);
  return pid;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return dflt;
    return argv.splice(i, 2)[1];
  };
  if (argv.includes('--help') || argv.includes('-h')) return void console.log(USAGE);
  const port = opt('port', '8545');
  const rpc = `http://127.0.0.1:${port}`;
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'start': {
      const r = await start(port);
      console.log(r.running ? `already running on ${r.rpc}` : `anvil fork of Base Sepolia on ${r.rpc} (pid ${r.pid}; log .fork.${port}.log)`);
      break;
    }
    case 'stop': console.log(`stopped pid ${stop(port)}`); break;
    case 'fund': {
      const eth = opt('eth', '0.1');
      const satori = opt('satori', '0');
      await fund(rpc, argv.slice(1), { eth, satori });
      console.log(`funded ${argv.slice(1).join(', ')}: ${eth} ETH${Number(satori) ? `, ${satori} SATORI` : ''}`);
      break;
    }
    case 'airdrop': console.log(await airdrop(rpc, args[0], args[1])); break;
    case 'merkle': console.log(JSON.stringify(await merkle(rpc, args[0], args[1]))); break;
    case 'advance': await advance(rpc, args[0] ?? 1); console.log(`advanced ${args[0] ?? 1} day(s)`); break;
    case 'predict': console.log(await predict(rpc, args[0])); break;
    case 'stream': console.log(JSON.stringify(await stream(rpc, args[0] ?? `junk-${Date.now()}`))); break;
    case 'grief': console.log(JSON.stringify(await grief(rpc, args[0]))); break;
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.shortMessage ?? err.message ?? err);
    process.exit(1);
  });
}
