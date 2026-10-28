// The daily push's wake (docs/design/push.md): the service worker, woken by the push server, sends the day's batch
// itself when it can, and always shows one notification saying what happened. It can't open the app's database (DuckDB
// needs a worker of its own), so the app leaves it a handoff in IndexedDB: the alias (sealed with this browser's key,
// src/keys/atrest.js), the chain's config and RPCs, the max fee and how the app plays. The batch is the app's own
// (runBatch): the same streams read from the chain, the same forecasts, a fresh day. What it sends is kept in IndexedDB
// for the app to take in at its next check (adopt, handoff.js), so it waits for that batch as for its own.
import { SKIP } from '../neuron/skip.js';
import { fallback, http } from 'viem';
import { createChain } from '../chain/index.js';
import { runBatch } from '../neuron/base.js';
import { fromRest, DEVICE_KEY } from '../keys/atrest.js';
import { checkKey, evmAddress, publicKey, signDigest } from '../keys/keys.js';
import { hexToBytes } from '@noble/hashes/utils';
import { HANDOFF, batchDb } from './handoff.js';

export const REMIND = { title: 'Satori', body: "Today's predictions aren't sent yet. Open the app to send them.", url: '/' };
export const GAME = { title: 'Satori', body: "Today's game is ready.", url: '/#game' };
const SENT = (n) => ({ title: 'Satori', body: `Satori sent today's predictions (${n} ${n === 1 ? 'game' : 'games'}).`, url: '/' });
const IN = { title: 'Satori', body: "Today's predictions are in.", url: '/' };

/** The alias's signer from a handoff: its secret sealed with the device key, or in hex where this browser keeps none. */
async function aliasOf(h, get) {
  const { alias } = h.sealed ? await fromRest({ sealed: h.sealed }, await get(DEVICE_KEY)) : { alias: h.alias };
  const secret = checkKey(hexToBytes(alias));
  return { evmAddress: evmAddress(publicKey(secret)), signDigest: (d) => signDigest(secret, d) };
}

/** The handoff's chain: its config, over its RPCs, every write under its max fee. */
const chainFor = (h, maxFeeWei) => createChain({ config: h.config, maxFee: async () => maxFeeWei,
  transport: h.rpc.length === 1 ? http(h.rpc[0]) : fallback(h.rpc.map((u) => http(u))) });

/**
 * What a push does. get/put: IndexedDB's satori/app. lock(fn): fn() under BATCH_LOCK, or null when the app holds it.
 * chainOf, runBatch: tests'.
 * → the notification { title, body, url }. Never throws: anything that goes wrong is the reminder.
 */
export async function wake({ get, put, lock = (fn) => fn(), chainOf = chainFor, runBatch: run = runBatch }) {
  try {
    const h = await get(HANDOFF);
    if (!h) return REMIND;
    if (h.play === 'manual') return GAME;
    if (!h.staked) return REMIND; // nothing staked with this app: no batch to send, the app's other work needs it open
    const alias = await aliasOf(h, get);
    const maxFeeWei = BigInt(h.maxFeeWei);
    const chain = chainOf(h, maxFeeWei);
    const r = await lock(async () => {
      // a transaction from the alias not mined yet (the app's batch, sent before it closed): not a second one
      if ((await chain.nonce(alias.evmAddress, 'pending')) > (await chain.nonce(alias.evmAddress, 'latest'))) return null;
      return run({ chain, alias, db: batchDb(get, put), maxFeeWei });
    });
    if (r?.sent) return SENT(r.sent.games.length);
    if (r?.skip === SKIP.predicted) return IN;
    return REMIND;
  } catch (err) {
    console.warn('[satori] push wake', err);
    return REMIND;
  }
}
