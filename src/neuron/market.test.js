// Paid streams (docs/design/market.md#selling-and-buying-over-the-relays): a seller and a buyer, each its own market, over
// a fake relay (each published event handed to the other) and a fake of the channel contract with the real voucher and
// binding signatures: listing, the channel accepted on chain, deliveries encrypted to paying buyers only, vouchers
// checked, settle, stop and the refund after the grace period; forged channels, bindings and vouchers refused.
import { beforeEach, describe, expect, test } from 'vitest';
import { keccak256, toHex } from 'viem';
import { DEFAULTS } from '../chain/config.js';
import { CLOSE_GRACE_S, ChannelError, verifyVoucher } from '../chain/channels.js';
import { fakeChannels } from '../../test/fake-channels.js';
import { publicKey, evmAddress, signDigest } from '../keys/keys.js';
import { nostrPubkey, signEvent, verifyEvent } from '../nostr/event.js';
import { nip04Decrypt } from '../nostr/nip04.js';
import { KIND, announceEvent, catalog, predMetadata, paymentEvent, subscriptionEvent } from '../nostr/satori.js';
import {
  amountOf, bindingSigner, bindingText, createMarket, deliverable, listingOf, signBinding, DEPOSIT_OBS,
} from './market.js';

const signer = (hex) => {
  const secret = Uint8Array.from(Buffer.from(hex, 'hex'));
  return { evmAddress: evmAddress(publicKey(secret)), signDigest: (h) => signDigest(secret, h) };
};
const S_NOSTR = '5'.repeat(64);
const B_NOSTR = '6'.repeat(64);
const X_NOSTR = '7'.repeat(64); // someone else
const S_ID = signer('11'.repeat(32));
const B_ID = signer('22'.repeat(32));
const X_ID = signer('33'.repeat(32));
const S_VAULT = signer('44'.repeat(32));
const B_VAULT = signer('55'.repeat(32));
const STREAM = 'walk_pred';
const PRICE = 1000n;
let clock;

function memoryKv() {
  const kv = new Map();
  return { kv, get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : undefined), set: async (k, v) => void kv.set(k, JSON.stringify(v)), checkpoint: async () => {} };
}

let chainApi;
let relay; // every event published, in order; handed to the other side by deliver()
let seller;
let buyer;
let sdb;
let bdb;
let vaultOpen;
const make = (who, db, extra = {}) => createMarket({ db, key: who === 's' ? { secret: S_NOSTR, pubkey: nostrPubkey(S_NOSTR) } : { secret: B_NOSTR, pubkey: nostrPubkey(B_NOSTR) },
  identity: who === 's' ? S_ID : B_ID, vaultAddress: who === 's' ? S_VAULT.evmAddress : B_VAULT.evmAddress, vault: () => (who === 'b' && vaultOpen ? B_VAULT : null),
  chain: async () => ({ channels: chainApi, config: DEFAULTS, chainTime: async () => clock }), now: () => clock,
  publish: async (e) => { relay.push(e); return 1; }, sendKept: async (list) => { relay.push(...list); }, ...extra });
const SP = nostrPubkey(S_NOSTR);
const BP = nostrPubkey(B_NOSTR);

/** The seller's listing as the buyer finds it: its verified catalog entry. */
const entryOf = (market = seller.listing(STREAM)) => catalog([signEvent(announceEvent(predMetadata({ sub: { stream_name: 'walk', provider_pubkey: 'ab'.repeat(32),
  name: 'Walk', cadence_seconds: 60, pred_created_at: 1 }, pubkey: SP, walletPubkey: '02ab', market }), clock), S_NOSTR)])[0];
const last = (kind) => relay.filter((e) => e.kind === kind).at(-1);
/** One observation of the seller's stream, delivered and (when the buyer gets it) paid; the payment handed to the seller. → the deliveries */
async function observe(seq, value = String(100 + seq), { pay = true } = {}) {
  const before = relay.length;
  const out = await seller.deliver(STREAM, { seq, timestamp: clock, value });
  const got = [];
  for (const e of out) got.push(await buyer.received(e));
  const payments = relay.slice(before).filter((e) => e.kind === KIND.PAYMENT);
  if (pay) for (const p of payments) await seller.onEvent(p);
  clock += 60;
  return { out, got, payments };
}
const sale = () => Object.values(sdb.kv.has('market') ? JSON.parse(sdb.kv.get('market')).sales : {})[0];

beforeEach(async () => {
  clock = 1_792_100_000;
  chainApi = fakeChannels(() => clock);
  relay = [];
  sdb = memoryKv();
  bdb = memoryKv();
  vaultOpen = true;
  seller = make('s', sdb);
  buyer = make('b', bdb);
  await seller.load();
  await buyer.load();
});

describe('pieces', () => {
  test('a price in SATORI → wei; zero, negative, words and more than 18 decimals refused', () => {
    expect(amountOf('0.001')).toBe(10n ** 15n);
    expect(amountOf(' 2 ')).toBe(2n * 10n ** 18n);
    for (const bad of ['0', '-1', 'abc', '', '0.0000000000000000001', '1e3']) expect(() => amountOf(bad), bad).toThrow(/positive amount of SATORI/);
  });
  test("the binding: the identity's EIP-191 signature of the channel and the Nostr key; another key, channel or Nostr key recovers no match", async () => {
    const id = keccak256(toHex('c'));
    expect(bindingText(id, BP)).toBe(`satori-market:v1:${id}:${BP}`);
    const sig = signBinding(B_ID, id, BP);
    expect(await bindingSigner(id, BP, sig)).toBe(B_ID.evmAddress);
    expect(await bindingSigner(id, SP, sig)).not.toBe(B_ID.evmAddress);
    expect(await bindingSigner(keccak256(toHex('d')), BP, sig)).not.toBe(B_ID.evmAddress);
    expect(await bindingSigner(id, BP, '0x1234')).toBeNull();
  });
  test('a listing: this chain, the Satori contract, SATORI, a payee and a price above 0; anything else is none', () => {
    const m = { chain: 84532, contract: DEFAULTS.channels, token: DEFAULTS.token, payee: S_VAULT.evmAddress, price: '1000' };
    expect(listingOf({ metadata: { market: m } })).toEqual({ ...m, price: 1000n });
    for (const bad of [{ chain: 8453 }, { contract: '0x' + '1'.repeat(40) }, { token: '0x' + '2'.repeat(40) }, { payee: 'nope' }, { price: '0' },
      { price: '-5' }, { price: 'x' }, { price: (2n ** 96n).toString() }]) {
      expect(listingOf({ metadata: { market: { ...m, ...bad } } }), JSON.stringify(bad)).toBeNull();
    }
    expect(listingOf({ metadata: null })).toBeNull();
  });
  test('deliverable: the first free, then only while the newest voucher covers every one delivered and the deposit one more', () => {
    const s = { base: '0', delivered: 0, price: '10', cumulative: '0', deposit: '30', closing: false };
    expect(deliverable(s)).toBe(true);
    expect(deliverable({ ...s, delivered: 1 })).toBe(false);
    expect(deliverable({ ...s, delivered: 1, cumulative: '10' })).toBe(true);
    expect(deliverable({ ...s, delivered: 3, cumulative: '30' })).toBe(false); // the deposit is spent
    expect(deliverable({ ...s, closing: true })).toBe(false);
    expect(deliverable({ ...s, base: '50', cumulative: '50', deposit: '60' })).toBe(true); // a channel accepted with 50 settled
  });
});

describe('selling and buying', () => {
  async function bought(deposit = 5n * PRICE) {
    await seller.sell(STREAM, PRICE);
    const v = await buyer.buy(entryOf(), deposit);
    await seller.onEvent(last(KIND.SUBSCRIPTION));
    return v;
  }

  test('sell: the listing (the vault paid, SATORI, the Satori contract); unsell: free again', async () => {
    await seller.sell(STREAM, PRICE);
    expect(seller.priced(STREAM)).toBe(true);
    expect(seller.listing(STREAM)).toEqual({ chain: 84532, contract: DEFAULTS.channels, token: DEFAULTS.token, payee: S_VAULT.evmAddress, price: '1000' });
    expect(seller.status().selling).toEqual([{ stream: STREAM, price: '0.000000000000001', buyers: [] }]);
    await seller.unsell(STREAM);
    expect(seller.listing(STREAM)).toBeNull();
    expect(await seller.deliver(STREAM, { seq: 1, timestamp: clock, value: '1' })).toEqual([]);
  });

  test('buy: the vault opens a channel to the payee, the 34602 names it with the binding; the seller accepts it from the chain', async () => {
    const v = await bought();
    expect(v).toMatchObject({ pubkey: SP, stream: STREAM, price: '0.000000000000001', deposit: '0.000000000000005', paid: '0', status: 'open' });
    const ch = chainApi.map.get(v.channel);
    expect(ch).toMatchObject({ payer: B_VAULT.evmAddress, payee: S_VAULT.evmAddress, signer: B_ID.evmAddress, deposit: 5000n });
    const sub = last(KIND.SUBSCRIPTION);
    expect(verifyEvent(sub)).toBe(true);
    expect(sub.tags).toEqual([['d', STREAM], ['p', SP], ['stream', STREAM], ['satori', 'subscription']]);
    const pc = JSON.parse(sub.content).payment_channel;
    expect(pc).toMatchObject({ chain: 84532, contract: DEFAULTS.channels, id: v.channel });
    expect(await bindingSigner(v.channel, BP, pc.binding)).toBe(B_ID.evmAddress);
    expect(seller.status().selling[0].buyers).toEqual([{ pubkey: BP, channel: v.channel, delivered: 0, paid: '0', settled: '0', deposit: '0.000000000000005',
      closing: false }]);
    expect(buyer.pairs()).toEqual([[SP, `${STREAM}:${BP}`]]); // its own d is followed
    expect(buyer.bought()).toEqual(new Set([`${SP}:${STREAM}`]));
    // again while it is open: the same channel, nothing opened
    expect((await buyer.buy(entryOf(), 5n * PRICE)).channel).toBe(v.channel);
    expect(chainApi.calls.filter((c) => c === 'open')).toHaveLength(1);
  });

  test('each observation encrypted to the buyer alone, the first free; each one received paid with the next cumulative voucher', async () => {
    const v = await bought();
    const a = await observe(1, '101.5');
    expect(a.out).toHaveLength(1);
    const [d] = a.out;
    expect(d.tags).toEqual([['d', `${STREAM}:${BP}`], ['p', BP], ['stream', STREAM], ['seq', '1'], ['timestamp', String(clock - 60)], ['satori', 'observation']]);
    expect(d.content).not.toContain('101.5');
    expect(await nip04Decrypt(B_NOSTR, SP, d.content)).toBe('101.5');
    expect(a.got).toEqual([{ stream_name: STREAM, provider: SP, timestamp: clock - 60, value: '101.5', seq: 1, id: d.id }]);
    // the payment: Lite's 34603 for seq + 1, the voucher inside, encrypted to the seller
    const [p] = a.payments;
    expect(p.tags).toEqual([['d', STREAM], ['p', SP], ['stream', STREAM], ['seq', '2']]);
    const body = JSON.parse(await nip04Decrypt(S_NOSTR, BP, p.content));
    expect(body).toMatchObject({ from_pubkey: BP, to_pubkey: SP, stream_name: STREAM, seq_num: 2, amount: '1000',
      voucher: { channel: v.channel, cumulative: '1000' } });
    expect(await verifyVoucher({ chainId: 84532, channelId: v.channel, cumulative: 1000n, signature: body.voucher.signature, signer: B_ID.evmAddress })).toBe(true);
    for (let k = 2; k <= 4; k++) expect((await observe(k)).out).toHaveLength(1);
    expect(seller.status().selling[0].buyers[0]).toMatchObject({ delivered: 4, paid: '0.000000000000004' });
    expect(buyer.status().bought[0]).toMatchObject({ paid: '0.000000000000004', left: '0.000000000000001', received: 4 });
    // a delivery seen again (a relay replays it) is not paid twice
    expect(await buyer.received(a.out[0])).toBeNull();
    expect(buyer.status().bought[0].paid).toBe('0.000000000000004');
  });

  test("a buyer that doesn't pay gets nothing more; the deposit's end stops the seller and the buyer alike", async () => {
    await bought(3n * PRICE);
    await observe(1, '1', { pay: false });
    expect((await observe(2)).out).toEqual([]); // the voucher for 1 never came
    await seller.onEvent(last(KIND.PAYMENT)); // it comes late
    expect((await observe(3)).out).toHaveLength(1);
    expect((await observe(4)).out).toHaveLength(1);
    expect(buyer.status().bought[0].left).toBe('0');
    expect((await observe(5)).out).toEqual([]); // 3 delivered and paid: the deposit holds no fourth
  });

  test('a relay that took no delivery: not owed, so the next one still goes', async () => {
    await bought();
    const s = make('s', sdb, { publish: async () => 0 });
    await s.load();
    const out = await s.deliver(STREAM, { seq: 1, timestamp: clock, value: '1' });
    expect(out).toHaveLength(1);
    expect(sale().delivered).toBe(0);
  });

  test('forgeries: a channel bound to another Nostr key or signed by another identity, another payee, a closing channel; bad vouchers', async () => {
    await seller.sell(STREAM, PRICE);
    const v = await buyer.buy(entryOf(), 5n * PRICE);
    const pc = JSON.parse(last(KIND.SUBSCRIPTION).content).payment_channel;
    const claim = (secret, channel) => signEvent(subscriptionEvent({ stream: STREAM, provider: SP, subscriber: nostrPubkey(secret), now: clock,
      paymentChannel: channel }), secret);
    await seller.onEvent(claim(X_NOSTR, pc)); // the buyer's channel claimed by another Nostr key
    await seller.onEvent(claim(X_NOSTR, { ...pc, binding: signBinding(X_ID, v.channel, nostrPubkey(X_NOSTR)) })); // bound by another identity
    expect(seller.status().selling[0].buyers).toEqual([]);
    // a channel paying someone else
    const other = await chainApi.openChannel({ vault: B_VAULT, identity: B_ID, payee: X_ID.evmAddress, deposit: 5000n });
    await seller.onEvent(claim(B_NOSTR, { ...pc, id: other.id, binding: signBinding(B_ID, other.id, BP) }));
    expect(seller.status().selling[0].buyers).toEqual([]);
    // the real one
    await seller.onEvent(last(KIND.SUBSCRIPTION));
    expect(seller.status().selling[0].buyers).toHaveLength(1);
    await observe(1, '1', { pay: false });
    const pay = async (body, secret = B_NOSTR) => {
      const { nip04Encrypt } = await import('../nostr/nip04.js');
      const content = await nip04Encrypt(secret, SP, JSON.stringify(body));
      await seller.onEvent(signEvent(paymentEvent({ stream: STREAM, provider: SP, seq: 2, content, now: clock }), secret));
    };
    const { signVoucher } = await import('../chain/channels.js');
    const voucher = async (who, cumulative) => ({ channel: v.channel, cumulative: String(cumulative),
      signature: await signVoucher(who, { chainId: 84532, channelId: v.channel, cumulative }) });
    await pay({ stream_name: STREAM, voucher: await voucher(X_ID, 1000n) }); // not the channel's signer
    await pay({ stream_name: STREAM, voucher: await voucher(B_ID, 9000n) }); // past the deposit
    await pay({ stream_name: STREAM, voucher: await voucher(B_ID, 1000n) }, X_NOSTR); // from another Nostr key
    expect(sale().cumulative).toBe('0');
    await pay({ stream_name: STREAM, voucher: await voucher(B_ID, 1000n) });
    expect(sale().cumulative).toBe('1000');
    await pay({ stream_name: STREAM, voucher: await voucher(B_ID, 1000n) }); // no rise
    await pay({ stream_name: STREAM, voucher: { ...(await voucher(B_ID, 2000n)), signature: '0x' + '1'.repeat(130) } });
    expect(sale().cumulative).toBe('1000');
  });

  test('the hourly pass settles every voucher above what is settled, once; a close request stops deliveries and is settled', async () => {
    const v = await bought();
    await observe(1);
    await observe(2);
    await seller.pass();
    expect(chainApi.map.get(v.channel).settled).toBe(2000n);
    expect(seller.status().selling[0].buyers[0].settled).toBe('0.000000000000002');
    await seller.pass();
    expect(chainApi.calls.filter((c) => c[0] === 'settleMany')).toEqual([['settleMany', 1]]); // nothing new: no transaction
    await observe(3);
    chainApi.map.get(v.channel).closeRequestedAt = clock; // asked on chain (by its vault, say)
    await seller.pass();
    expect(chainApi.map.get(v.channel).settled).toBe(3000n);
    expect(seller.status().selling[0].buyers).toEqual([]); // nothing more due: it goes
    expect((await observe(4)).out).toEqual([]);
  });

  test("stop: the identity asks to close, Lite's unsubscribe; the seller settles at once; the refund after the grace period, in the pass", async () => {
    const v = await bought();
    await observe(1);
    await observe(2);
    const s = await buyer.stop(SP, STREAM);
    expect(s).toMatchObject({ status: 'closing', closeAt: clock + CLOSE_GRACE_S, paid: '0.000000000000002' });
    const u = last(KIND.SUBSCRIPTION);
    expect(u.tags).toEqual([['d', STREAM], ['p', SP], ['stream', STREAM], ['action', 'unsubscribe'], ['satori', 'unsubscription']]);
    expect(buyer.pairs()).toEqual([]);
    await seller.onEvent(u);
    await new Promise((r) => setTimeout(r, 50)); // its settle runs beside the intake
    expect(chainApi.map.get(v.channel).settled).toBe(2000n);
    expect(seller.status().selling[0].buyers).toEqual([]);
    await expect(buyer.stop(SP, STREAM)).rejects.toThrow(/Not buying/);
    await buyer.pass(); // the grace period runs: nothing
    expect(chainApi.calls).not.toContain('withdraw');
    expect(buyer.status().bought[0].status).toBe('closing');
    clock += CLOSE_GRACE_S;
    await buyer.pass();
    expect(chainApi.calls).toContain('withdraw');
    expect(buyer.status().bought).toEqual([]); // refunded to the vault
    expect(buyer.bought()).toEqual(new Set());
  });

  test('buy again after a stop: a new channel; the seller closes the old one and serves the new', async () => {
    const v1 = await bought();
    await observe(1);
    await buyer.stop(SP, STREAM);
    const v2 = await buyer.buy(entryOf(), 5n * PRICE);
    expect(v2.channel).not.toBe(v1.channel);
    await seller.onEvent(last(KIND.SUBSCRIPTION));
    await new Promise((r) => setTimeout(r, 50));
    expect(seller.status().selling[0].buyers.map((b) => b.channel)).toEqual([v2.channel]);
    expect(chainApi.map.get(v1.channel).settled).toBe(1000n);
    expect(buyer.status().bought.map((b) => b.status)).toEqual(['closing', 'open']);
  });

  test("what can't buy: locked vault, a stream not listed, a deposit under one price, a staked vault (in plain words, nothing kept)", async () => {
    await seller.sell(STREAM, PRICE);
    vaultOpen = false;
    await expect(buyer.buy(entryOf(), 5000n)).rejects.toThrow('Unlock the vault first');
    vaultOpen = true;
    await expect(buyer.buy(entryOf(null), 5000n)).rejects.toThrow('not for sale on the Satori contract');
    await expect(buyer.buy(entryOf(), 999n)).rejects.toThrow('at least one observation');
    chainApi.refuse = new ChannelError("Your vault is staked with this neuron, so it can't send SATORI: a channel needs SATORI the vault can send.",
      { reason: 'Locked' });
    await expect(buyer.buy(entryOf(), 5000n)).rejects.toThrow("Your vault is staked with this neuron, so it can't send SATORI");
    expect(buyer.status().bought).toEqual([]);
    expect(relay.filter((e) => e.kind === KIND.SUBSCRIPTION)).toEqual([]);
    // the default deposit: 100 observations
    chainApi.refuse = null;
    expect(DEPOSIT_OBS).toBe(100);
    expect((await buyer.buy(entryOf())).deposit).toBe('0.0000000000001'); // 100 × 1000 wei
  });

  test('kept: a reload has the price, the buyers and what each paid, and what we buy', async () => {
    const v = await bought();
    await observe(1);
    const s2 = make('s', sdb);
    const b2 = make('b', bdb);
    await s2.load();
    await b2.load();
    expect(s2.priced(STREAM)).toBe(true);
    expect(s2.status().selling[0].buyers[0]).toMatchObject({ channel: v.channel, delivered: 1, paid: '0.000000000000001' });
    expect(b2.status().bought[0]).toMatchObject({ channel: v.channel, paid: '0.000000000000001', received: 1 });
  });
});
