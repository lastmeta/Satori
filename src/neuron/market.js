// Paid streams over the Satori Network (docs/design/market.md#selling-and-buying-over-the-relays): satorilib's data-stream
// market (satori_nostr/client.py), its Evrmore parts replaced by the Satori contract's payment channels (src/chain/channels.js).
//   sell: our `<stream>_pred` announced with Lite's price_per_obs (satoshis); each observation encrypted (NIP-04) to each
//   buyer in good standing
//   buy: the wallet opens a channel (Unlock), the 34602 names it; each delivery received → the alias's next voucher (34603)
//   the seller checks the channel on chain and each voucher; it settles (settleMany) at most once a week, and at once for a
//   channel closing (its grace period: 7 days unless one side changed it)
//   stop: the alias asks to close; after the grace period what is left stays in the channel, taken back by the wallet
//   (any amount, any address) or used again by the next Buy of that stream (cancelClose, a top-up if short)
// Kept in meta `market`: { prices (wei), sales, buys, settledAt }, amounts as decimal strings.
import { formatEther, hashMessage, hexToBytes, parseEther, recoverMessageAddress, serializeSignature, isAddress } from 'viem';
import { DEFAULTS } from '../chain/config.js';
import { CLOSE_GRACE_S, MAX_AMOUNT, channelErrorText, signVoucher, verifyVoucher } from '../chain/channels.js';
import { same } from '../chain/index.js';
import { signEvent, verifyEvent } from '../nostr/event.js';
import { nip04Decrypt, nip04Encrypt } from '../nostr/nip04.js';
import { KIND, deliveryEvent, deliveryOf, parseSubscription, paymentEvent, paymentJson, subscriptionEvent } from '../nostr/satori.js';

export const DEPOSIT_OBS = 100; // a Buy's deposit unless one is given: 100 observations
export const SAT = 10n ** 10n; // wei per satoshi: price_per_obs is Lite's, in satoshis (10⁻⁸ SATORI)
export const SETTLE_EVERY_S = 7 * 86_400; // the seller settles at most once a week (owner, 2026-10-25): each settle costs gas; a closing channel at once
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const B = (x) => BigInt(x ?? 0);
const sat = (wei) => formatEther(B(wei));

/** What the alias signs to say this Nostr key may use the channel (EIP-191). */
export const bindingText = (channelId, nostrPubkey) => `satori-market:v1:${String(channelId).toLowerCase()}:${nostrPubkey}`;
/** The alias's binding (our signer: signDigest, inside it; no Unlock). */
export const signBinding = (alias, channelId, nostrPubkey) =>
  serializeSignature(alias.signDigest(hexToBytes(hashMessage(bindingText(channelId, nostrPubkey)))));
/** Who signed a binding, or null. */
export async function bindingSigner(channelId, nostrPubkey, binding) {
  try {
    return await recoverMessageAddress({ message: bindingText(channelId, nostrPubkey), signature: binding });
  } catch {
    return null;
  }
}

/** An amount of SATORI as typed ('0.001') → wei, more than 0 and at most 2^96 − 1; else it throws in plain words. */
export function amountOf(text, what = 'The price') {
  let wei;
  try { wei = parseEther(String(text ?? '').trim()); } catch { wei = 0n; }
  if (!(wei > 0n) || wei > MAX_AMOUNT) throw new Error(`${what} must be a positive amount of SATORI.`);
  return wei;
}

/** A price as typed ('0.001') → wei: a positive amount of SATORI in whole satoshis (price_per_obs is Lite's, in satoshis). */
export function priceOf(text) {
  const wei = amountOf(text);
  if (wei % SAT) throw new Error('The price can have at most 8 decimal places.');
  return wei;
}

/**
 * A catalog entry for sale on this chain's Satori contract: its price_per_obs (satoshis, above 0) and metadata.market
 * (chain, contract, token SATORI, a payee address) → { chain, contract, token, payee, price: bigint wei }, or null.
 */
export function listingOf(entry, config = DEFAULTS) {
  const m = entry?.metadata?.market;
  const sats = entry?.price_per_obs;
  if (!Number.isSafeInteger(sats) || sats <= 0 || !m || typeof m !== 'object' || Number(m.chain) !== config.chainId
    || !same(m.contract, config.channels) || !same(m.token, config.token) || typeof m.payee !== 'string' || !isAddress(m.payee)) return null;
  return { chain: config.chainId, contract: config.channels, token: config.token, payee: m.payee, price: BigInt(sats) * SAT };
}

/** What a sale's buyer owes for what it was delivered: from the channel's settled amount when it was accepted. */
const owed = (s) => B(s.base) + B(s.delivered) * B(s.price);
/** A buyer gets the next observation while its close isn't asked, its newest voucher covers every one delivered (the first is free), and its deposit one more. */
export const deliverable = (s) => !s.closing && B(s.cumulative) >= owed(s) && B(s.deposit) >= owed(s) + B(s.price);

/**
 * @param {object} o
 * @param {object} o.db get/set/checkpoint
 * @param {{secret: string, pubkey: string}} o.key the Nostr key
 * @param {object|null} o.alias our signer (signDigest, evmAddress): vouchers, the binding, settle, close, withdraw
 * @param {string|null} o.walletAddress the seller's payee
 * @param {() => object|null} o.wallet the wallet while unlocked (a Buy opens the channel from it)
 * @param {() => Promise<{channels: object, config: object, chainTime: () => Promise<number>}>} o.chain the channel client on the current chain
 * @param {(event: object) => Promise<number>} o.publish to the relays we write to → how many took it
 * @param {(events: object[]) => Promise<void>} o.sendKept the same, kept until each relay took it (a subscription, a payment, an unsubscribe)
 */
export function createMarket({ db, key, alias = null, walletAddress = null, wallet = () => null, chain, publish, sendKept = async () => {},
  now = () => Date.now() / 1000, onChange = () => {}, config = DEFAULTS }) {
  let m = { prices: {}, sales: {}, buys: {} };
  let lastError = null; // the hourly pass's last failure
  const t = () => Math.floor(now());
  const sign = (template) => signEvent(template, key.secret);
  const log = (err) => console.warn('[satori] market', err?.message ?? err);
  const save = async () => {
    await db.set('market', m);
    await db.checkpoint();
    onChange();
  };
  const salesOf = (stream) => Object.values(m.sales).filter((s) => s.stream === stream);
  const openBuy = (pubkey, stream) => Object.values(m.buys).find((b) => b.pubkey === pubkey && b.stream === stream && b.status === 'open');
  const needAlias = () => {
    if (!alias) throw new Error('No alias to sign with.');
    return alias;
  };

  /**
   * Once a week at most, or at once when a channel with something due is closing (the close signal: its grace period
   * is 7 days): every sale's newest voucher above what is settled, in one transaction (the seller's alias, into the
   * wallet). A closing sale goes once nothing is due.
   */
  async function collect() {
    const list = Object.values(m.sales);
    const due = list.filter((s) => s.signature && B(s.cumulative) > B(s.settled));
    if (due.length && (t() - (m.settledAt ?? 0) >= SETTLE_EVERY_S || due.some((s) => s.closing))) {
      const { channels } = await chain();
      const r = await channels.settleMany(needAlias(), due.map((s) => ({ id: s.channel, cumulative: B(s.cumulative), signature: s.signature })));
      for (const x of r.settled) for (const s of due) if (s.channel === x.id) s.settled = String(x.settled);
      m.settledAt = t();
    }
    // a closing sale goes once everything delivered is paid and settled (a last voucher may still be on its way);
    // else when its channel is closed (pass)
    for (const s of list) if (s.closing && B(s.settled) >= owed(s)) delete m.sales[s.channel];
    await save();
  }

  /** A buyer's 34602 to one of our priced streams: its channel read on chain and accepted, or its unsubscribe (no more deliveries). */
  async function onSubscription(e) {
    const sub = parseSubscription(e);
    if (!sub || sub.provider !== key.pubkey || sub.subscriber !== e.pubkey) return;
    // the buyer's channels on this stream still served: an unsubscribe, or a new channel, closes them (their last vouchers
    // collected in the daily settle, well inside the 7-day grace period)
    const was = Object.values(m.sales).filter((s) => s.stream === sub.stream_name && s.buyer === e.pubkey && !s.closing);
    const close = () => {
      for (const s of was) s.closing = true;
    };
    if (sub.unsubscribe) {
      close();
      return was.length ? save() : undefined;
    }
    const price = m.prices[sub.stream_name];
    const c = sub.channel;
    if (!price || !c || !HEX32.test(String(c.id)) || Number(c.chain) !== config.chainId || !same(c.contract, config.channels)) return;
    const known = m.sales[c.id];
    if (known && !known.closing) return; // seen (a relay sends it again on each connect)
    const { channels } = await chain();
    const ch = await channels.readChannel(c.id);
    const signer = await bindingSigner(c.id, e.pubkey, c.binding);
    if (!ch || !same(ch.payee, walletAddress) || !same(ch.token, config.token) || !same(ch.signer, signer) || ch.closed || ch.closeRequestedAt
      || ch.deposit - ch.settled < B(price)) return;
    close();
    if (known && known.stream === sub.stream_name && known.buyer === e.pubkey) { // a stopped channel used again: served again
      Object.assign(known, { deposit: String(ch.deposit), settled: String(ch.settled), grace: ch.grace, payout: ch.payout, closing: false });
    } else {
      m.sales[c.id] = { stream: sub.stream_name, buyer: e.pubkey, channel: c.id, signer: ch.signer, price, base: String(ch.settled),
        deposit: String(ch.deposit), settled: String(ch.settled), cumulative: String(ch.settled), signature: null, delivered: 0, closing: false,
        grace: ch.grace, payout: ch.payout };
    }
    await save();
  }

  /** A buyer's 34603: its voucher kept when it is the channel's signer's, more than the last, and within the deposit. */
  async function onPayment(e) {
    let p;
    try { p = JSON.parse(await nip04Decrypt(key.secret, e.pubkey, e.content)); } catch { return; }
    const v = p?.voucher;
    const s = m.sales[v?.channel];
    if (!s || s.buyer !== e.pubkey || s.stream !== p.stream_name) return;
    let cumulative;
    try { cumulative = BigInt(String(v.cumulative)); } catch { return; }
    if (cumulative <= B(s.cumulative) || cumulative > B(s.deposit)) return;
    if (!(await verifyVoucher({ chainId: config.chainId, contract: config.channels, channelId: s.channel, cumulative, signature: v.signature,
      signer: s.signer }))) return;
    s.cumulative = String(cumulative);
    s.signature = v.signature;
    await save();
  }

  return {
    async load() { m = { prices: {}, sales: {}, buys: {}, settledAt: 0, ...((await db.get('market')) ?? {}) }; },

    // ── selling ──
    /** Whether our stream has a price. */
    priced: (stream) => !!m.prices[stream],
    /** Its listing for the announcement (predMetadata's): price_per_obs in satoshis and the channel's market, or null when it is free. */
    listing: (stream) => (m.prices[stream] ? { price_per_obs: Number(B(m.prices[stream]) / SAT),
      market: { chain: config.chainId, contract: config.channels, token: config.token, payee: walletAddress } } : null),
    /** A price in wei, whole satoshis, on our stream (the caller re-announces it). */
    async sell(stream, wei) {
      if (!walletAddress) throw new Error('No wallet to be paid into.');
      if (B(wei) <= 0n || B(wei) % SAT) throw new Error('The price can have at most 8 decimal places.');
      m.prices[stream] = String(wei);
      await save();
    },
    /** Free again: no new deliveries; what buyers owe is still collected by the daily settle. */
    async unsell(stream) {
      delete m.prices[stream];
      await save();
    },
    /**
     * A new observation of our priced stream: encrypted to each buyer in good standing (deliverable), one event each,
     * counted as delivered once a relay took it. → the events
     */
    async deliver(stream, { seq, timestamp, value }) {
      const out = [];
      for (const s of salesOf(stream).filter(deliverable)) {
        const ev = sign(deliveryEvent({ stream, subscriber: s.buyer, seq, timestamp, now: t(),
          content: await nip04Encrypt(key.secret, s.buyer, String(value)) }));
        s.delivered++;
        out.push([s, ev]);
      }
      if (!out.length) return [];
      await save();
      await Promise.all(out.map(async ([s, ev]) => {
        if (!(await publish(ev))) s.delivered--; // no relay took it: it isn't owed
      }));
      await save();
      return out.map(([, ev]) => ev);
    },

    // ── buying ──
    /**
     * Buy a listed stream (`entry`: its verified catalog entry): the wallet opens a channel to the payee with `deposit`
     * (wei; 100 observations by default), then the 34602 names it, with the alias's binding to our Nostr key. → its view
     */
    async buy(entry, deposit) {
      const l = listingOf(entry, config);
      if (!l) throw new Error('That stream is not for sale on the Satori contract.');
      const was = openBuy(entry.pubkey, entry.stream_name);
      if (was) return this.view(was.channel);
      const amount = deposit ?? l.price * BigInt(DEPOSIT_OBS);
      if (amount < l.price) throw new Error(`The deposit must cover at least one observation (${sat(l.price)} SATORI).`);
      const v = wallet();
      if (!v) throw new Error('Unlock the wallet first');
      const { channels } = await chain();
      const old = Object.values(m.buys).find((b) => b.pubkey === entry.pubkey && b.stream === entry.stream_name);
      let id;
      try {
        const ch = old && await channels.readChannel(old.channel);
        if (old && !ch) throw new Error("Your earlier channel for this stream can't be read just now: try again in a minute.");
        if (ch && !ch.closed && same(ch.payee, l.payee) && same(ch.token, config.token) && same(ch.signer, needAlias().evmAddress)) {
          // its stopped channel used again: the close taken back, topped up to `amount` past what is spent (the vouchers
          // signed, or what is settled, which counts what was taken back)
          if (ch.closeRequestedAt) await channels.cancelClose(v, old.channel);
          const spent = B(old.cumulative) > ch.settled ? B(old.cumulative) : ch.settled;
          const short = spent + amount - ch.deposit;
          if (short > 0n) await channels.topUp(v, old.channel, short);
          id = old.channel;
          Object.assign(old, { name: entry.name ?? old.name, price: String(l.price), deposit: String(short > 0n ? ch.deposit + short : ch.deposit),
            settled: String(ch.settled), cumulative: String(spent), grace: ch.grace, status: 'open', closeAt: null, at: t() });
        } else {
          // ended, or no longer this seller's or our alias's: a new channel. A closed one is empty and goes; a live one is
          // never dropped (it holds the deposit): the wallet asks to close it and it is kept, closing, to take back after its grace period
          if (old && ch.closed) delete m.buys[old.channel];
          else if (old) {
            if (!ch.closeRequestedAt) await channels.requestClose(v, old.channel);
            const asked = await channels.readChannel(old.channel);
            Object.assign(old, { status: 'closing', closeAt: asked?.graceEndsAt ?? null });
          }
          const r = await channels.openChannel({ wallet: v, alias: needAlias(), payee: l.payee, deposit: amount });
          id = r.id;
          m.buys[id] = { pubkey: entry.pubkey, stream: entry.stream_name, name: entry.name ?? '', channel: id, hash: r.hash, price: String(l.price),
            deposit: String(amount), settled: '0', cumulative: '0', seq: null, status: 'open', closeAt: null, grace: CLOSE_GRACE_S, at: t() };
        }
      } catch (err) {
        throw new Error(channelErrorText(err), { cause: err });
      }
      await save();
      const binding = signBinding(alias, id, key.pubkey);
      await sendKept([sign(subscriptionEvent({ stream: entry.stream_name, provider: entry.pubkey, subscriber: key.pubkey, now: t(),
        paymentChannel: { chain: config.chainId, contract: config.channels, id, binding } }))]); // kept until a relay takes it
      return this.view(id);
    },
    /**
     * A 34601 that may be a delivery to us of a stream we bought: verified, decrypted → the observation (parseObservation's
     * shape), and paid: the alias signs the next voucher (never past the deposit) and sends it (34603). Else null.
     */
    async received(e) {
      const d = deliveryOf(e);
      const b = d && d.subscriber === key.pubkey ? openBuy(d.provider, d.stream_name) : null;
      if (!b || (b.seq != null && d.seq <= b.seq) || !verifyEvent(e)) return null;
      let value;
      try { value = await nip04Decrypt(key.secret, d.provider, e.content); } catch { return null; }
      b.seq = d.seq;
      const next = B(b.cumulative) + B(b.price);
      if (next <= B(b.deposit)) {
        const signature = await signVoucher(needAlias(), { chainId: config.chainId, contract: config.channels, channelId: b.channel, cumulative: next });
        b.cumulative = String(next);
        await save(); // kept before it is sent: a reload never signs it again
        const voucher = { channel: b.channel, cumulative: String(next), signature };
        const content = await nip04Encrypt(key.secret, d.provider, paymentJson({ from: key.pubkey, to: d.provider, stream: d.stream_name,
          seq: d.seq + 1, amountSats: Number(B(b.price) / SAT), timestamp: t(), voucher }));
        sendKept([sign(paymentEvent({ stream: d.stream_name, provider: d.provider, seq: d.seq + 1, content, now: t() }))]).catch(log); // kept until a relay takes it
      } else {
        await save();
      }
      return { stream_name: d.stream_name, provider: d.provider, timestamp: d.timestamp, value, seq: d.seq, id: e.id };
    },
    /**
     * Stop: the alias asks to close the channel (no Unlock), then Lite's unsubscribe. After the grace period what is
     * left can be taken back (takeBack), or the next Buy of the stream uses the channel again. → its view
     */
    async stop(pubkey, stream) {
      const b = openBuy(pubkey, stream);
      if (!b) throw new Error(`Not buying ${stream} from ${pubkey.slice(0, 8)}….`);
      const { channels } = await chain();
      try {
        await channels.requestClose(needAlias(), b.channel);
      } catch (err) {
        throw new Error(channelErrorText(err), { cause: err });
      }
      const ch = await channels.readChannel(b.channel);
      Object.assign(b, { status: 'closing', closeAt: ch?.graceEndsAt ?? null });
      await save();
      await sendKept([sign(subscriptionEvent({ stream, provider: pubkey, subscriber: key.pubkey, now: t(), unsubscribe: true }))]);
      return this.view(b.channel);
    },
    /**
     * After the grace period of a stopped (or closing) bought channel, the wallet takes `amount` wei (all that is not
     * settled by default) to `to` (the wallet by default); the channel stays for the next Buy. → its view
     */
    async takeBack(channel, amount, to) {
      const b = m.buys[channel];
      if (!b || b.status === 'open') throw new Error('Stop buying it first: what is left can be taken back after its grace period.');
      const v = wallet();
      if (!v) throw new Error('Unlock the wallet first');
      if (to != null && !isAddress(String(to), { strict: false })) throw new Error('That is not a Base address.');
      const { channels } = await chain();
      try {
        const ch = await channels.readChannel(channel);
        if (!ch || ch.closed) throw new Error('The channel is closed.');
        const left = ch.deposit - ch.settled;
        const take = amount ?? left;
        if (take <= 0n) throw new Error('Nothing is left in the channel.');
        if (take > left) throw new Error(`Only ${sat(left)} SATORI is left in the channel.`);
        await channels.withdrawTo(v, channel, take, to ?? undefined);
        Object.assign(b, { deposit: String(ch.deposit), settled: String(ch.settled + take) }); // taken back counts as settled
      } catch (err) {
        throw new Error(channelErrorText(err), { cause: err });
      }
      await save();
      return this.view(channel);
    },
    /**
     * A channel's grace period, set by our wallet (one we buy, or a buyer's of ours): longer by the buyer or shorter by
     * the seller applies at once, otherwise it is asked of the other side. → { applied, grace }
     */
    async setGrace(channel, seconds) {
      const rec = m.buys[channel] ?? m.sales[channel];
      if (!rec) throw new Error('No such channel bought or sold here.');
      const v = wallet();
      if (!v) throw new Error('Unlock the wallet first');
      const { channels } = await chain();
      let applied;
      try {
        // a shorter grace period also applies to a close already asked: what a buyer owes us is settled first
        const s = m.sales[channel];
        if (s && seconds < (s.grace ?? CLOSE_GRACE_S) && s.signature && B(s.cumulative) > B(s.settled)) {
          const r = await channels.settleMany(needAlias(), [{ id: channel, cumulative: B(s.cumulative), signature: s.signature }]);
          for (const x of r.settled) if (x.id === channel) s.settled = String(x.settled);
        }
        ({ applied } = await channels.setGrace(v, channel, seconds));
        rec.grace = (await channels.readChannel(channel))?.grace ?? rec.grace;
      } catch (err) {
        throw new Error(channelErrorText(err), { cause: err });
      }
      await save();
      return { applied, grace: rec.grace };
    },
    /** Where a buyer's channel of ours pays our settlements (the wallet by default); set by the wallet. → the buyer's entry */
    async setPayout(channel, address) {
      const s = m.sales[channel];
      if (!s) throw new Error('No buyer of ours has that channel.');
      const v = wallet();
      if (!v) throw new Error('Unlock the wallet first');
      const { channels } = await chain();
      try {
        await channels.setPayout(v, channel, address);
        s.payout = (await channels.readChannel(channel))?.payout ?? address;
      } catch (err) {
        throw new Error(channelErrorText(err), { cause: err });
      }
      await save();
      return this.status().selling.flatMap((x) => x.buyers).find((x) => x.channel === channel);
    },

    /** The follow REQ's pairs for what we buy: the seller and `<stream>:<our key>` (each buyer's own d). */
    pairs: () => Object.values(m.buys).filter((b) => b.status === 'open').map((b) => [b.pubkey, `${b.stream}:${key.pubkey}`]),
    /** `pubkey:stream` of the streams we buy: watched ahead of all but ours (records.js). */
    bought: () => new Set(Object.values(m.buys).map((b) => `${b.pubkey}:${b.stream}`)),

    /** A verified 34602 or 34603 addressed to us (the seller's side). */
    async onEvent(e) {
      if (e.kind === KIND.SUBSCRIPTION) return onSubscription(e);
      if (e.kind === KIND.PAYMENT) return onPayment(e);
      return undefined;
    },

    /**
     * The hourly pass (and the catch-up's): each sale's channel read again (its deposit, what is settled, a close asked:
     * no more deliveries, closed: gone), then, once a week at most (at once for a closing channel), one settleMany for every voucher above what is settled;
     * each bought channel read again too (its deposit, what is settled, its grace period): a closing one whose grace
     * period has ended is stopped (what is left can be taken back), an ended one gone.
     */
    async pass() {
      try {
        const sales = Object.values(m.sales);
        const buys = Object.values(m.buys);
        if (!sales.length && !buys.length) return;
        const { channels, chainTime } = await chain();
        // a channel goes only when the chain says it is closed: a read that finds none (a lagging RPC, another contract)
        // proves nothing, and the record is what lets its money be collected or taken back
        for (const s of sales) {
          const ch = await channels.readChannel(s.channel);
          if (!ch) continue;
          if (ch.closed) {
            delete m.sales[s.channel];
            continue;
          }
          Object.assign(s, { deposit: String(ch.deposit), settled: String(ch.settled), grace: ch.grace, payout: ch.payout,
            closing: s.closing || !!ch.closeRequestedAt || !m.prices[s.stream] });
        }
        await collect();
        const at = buys.some((b) => b.status === 'closing') ? await chainTime() : 0;
        for (const b of buys) {
          const ch = await channels.readChannel(b.channel);
          if (!ch) continue;
          if (ch.closed) {
            delete m.buys[b.channel];
            continue;
          }
          Object.assign(b, { deposit: String(ch.deposit), settled: String(ch.settled), grace: ch.grace });
          if (b.status === 'open') continue;
          b.closeAt = ch.graceEndsAt;
          if (b.status === 'closing' && ch.graceEndsAt != null && ch.graceEndsAt <= at) b.status = 'stopped';
        }
        await save();
        lastError = null;
      } catch (err) {
        lastError = channelErrorText(err);
        log(err);
      }
    },

    /** One bought stream (by its channel), for the UI and agents: amounts in SATORI. */
    view(channel) {
      const b = m.buys[channel];
      return b && { pubkey: b.pubkey, stream: b.stream, name: b.name, channel: b.channel, price: sat(b.price), deposit: sat(b.deposit),
        paid: sat(b.cumulative), left: sat(B(b.deposit) > B(b.cumulative) ? B(b.deposit) - B(b.cumulative) : 0n),
        refundable: sat(B(b.deposit) - B(b.settled ?? 0)), received: b.seq, status: b.status, closeAt: b.closeAt, grace: b.grace ?? CLOSE_GRACE_S };
    },
    /** nostr().market: what we sell (each buyer's channel, delivered, paid, settled) and what we buy. */
    status() {
      return {
        selling: Object.entries(m.prices).map(([stream, price]) => ({ stream, price: sat(price),
          buyers: salesOf(stream).map((s) => ({ pubkey: s.buyer, channel: s.channel, delivered: s.delivered, paid: sat(B(s.cumulative) - B(s.base)),
            settled: sat(s.settled), deposit: sat(s.deposit), closing: s.closing, grace: s.grace ?? CLOSE_GRACE_S,
            payout: s.payout ?? walletAddress, toWallet: same(s.payout ?? walletAddress, walletAddress) })) })),
        bought: Object.keys(m.buys).map((k) => this.view(k)),
        error: lastError,
      };
    },
  };
}
