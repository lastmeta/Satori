// Paid streams over the Satori relays (docs/design/market.md#selling-and-buying-over-the-relays): satorilib's data-stream
// market (satori_nostr/client.py), its Evrmore parts replaced by the Satori contract's payment channels (src/chain/channels.js).
//   sell: our `<stream>_pred` listed with a price; each observation encrypted (NIP-04) to each buyer in good standing
//   buy: the vault opens a channel (Unlock), the 34602 names it; each delivery received → the identity's next voucher (34603)
//   the seller checks the channel on chain and each voucher; the hourly pass settles (settleMany) and withdraws refunds
// Kept in meta `market`: { prices, sales, buys }, amounts as decimal strings.
import { formatEther, hashMessage, hexToBytes, parseEther, recoverMessageAddress, serializeSignature, isAddress } from 'viem';
import { DEFAULTS } from '../chain/config.js';
import { MAX_AMOUNT, channelErrorText, signVoucher, verifyVoucher } from '../chain/channels.js';
import { same } from '../chain/index.js';
import { signEvent, verifyEvent } from '../nostr/event.js';
import { nip04Decrypt, nip04Encrypt } from '../nostr/nip04.js';
import { KIND, deliveryEvent, deliveryOf, parseSubscription, paymentEvent, paymentJson, subscriptionEvent } from '../nostr/satori.js';

export const DEPOSIT_OBS = 100; // a Buy's deposit unless one is given: 100 observations
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const B = (x) => BigInt(x ?? 0);
const sat = (wei) => formatEther(B(wei));

/** What the identity signs to say this Nostr key may use the channel (EIP-191). */
export const bindingText = (channelId, nostrPubkey) => `satori-market:v1:${String(channelId).toLowerCase()}:${nostrPubkey}`;
/** The identity's binding (our signer: signDigest, inside it; no Unlock). */
export const signBinding = (identity, channelId, nostrPubkey) =>
  serializeSignature(identity.signDigest(hexToBytes(hashMessage(bindingText(channelId, nostrPubkey)))));
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

/**
 * A catalog entry's listing on this chain's Satori contract (metadata.market: chain, contract, token SATORI, a payee
 * address, a price in wei above 0) → { chain, contract, token, payee, price: bigint }, or null when it is none.
 */
export function listingOf(entry, config = DEFAULTS) {
  const m = entry?.metadata?.market;
  if (!m || typeof m !== 'object' || Number(m.chain) !== config.chainId || !same(m.contract, config.channels) || !same(m.token, config.token)
    || typeof m.payee !== 'string' || !isAddress(m.payee)) return null;
  let price;
  try { price = BigInt(String(m.price)); } catch { return null; }
  return price > 0n && price <= MAX_AMOUNT ? { chain: config.chainId, contract: config.channels, token: config.token, payee: m.payee, price } : null;
}

/** What a sale's buyer owes for what it was delivered: from the channel's settled amount when it was accepted. */
const owed = (s) => B(s.base) + B(s.delivered) * B(s.price);
/** A buyer gets the next observation while its close isn't asked, its newest voucher covers every one delivered (the first is free), and its deposit one more. */
export const deliverable = (s) => !s.closing && B(s.cumulative) >= owed(s) && B(s.deposit) >= owed(s) + B(s.price);

/**
 * @param {object} o
 * @param {object} o.db get/set/checkpoint
 * @param {{secret: string, pubkey: string}} o.key the Nostr key
 * @param {object|null} o.identity our signer (signDigest, evmAddress): vouchers, the binding, settle, close, withdraw
 * @param {string|null} o.vaultAddress the seller's payee
 * @param {() => object|null} o.vault the vault while unlocked (a Buy opens the channel from it)
 * @param {() => Promise<{channels: object, config: object, chainTime: () => Promise<number>}>} o.chain the channel client on the current chain
 * @param {(event: object) => Promise<number>} o.publish to the relays we write to → how many took it
 * @param {(events: object[]) => Promise<void>} o.sendKept the same, kept until each relay took it (a subscription, a payment, an unsubscribe)
 */
export function createMarket({ db, key, identity = null, vaultAddress = null, vault = () => null, chain, publish, sendKept = async () => {},
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
  const needIdentity = () => {
    if (!identity) throw new Error('No identity to sign with.');
    return identity;
  };

  /** Settle these sales' newest vouchers in one transaction (the seller's identity, into the vault); a closing one goes once nothing is due. */
  async function collect(list) {
    const due = list.filter((s) => s.signature && B(s.cumulative) > B(s.settled));
    if (due.length) {
      const { channels } = await chain();
      const r = await channels.settleMany(needIdentity(), due.map((s) => ({ id: s.channel, cumulative: B(s.cumulative), signature: s.signature })));
      for (const x of r.settled) for (const s of due) if (s.channel === x.id) s.settled = String(x.settled);
    }
    for (const s of list) if (s.closing && B(s.cumulative) <= B(s.settled) && m.sales[s.channel] === s) delete m.sales[s.channel];
    await save();
  }

  /** A buyer's 34602 to one of our priced streams: its channel read on chain and accepted, or its unsubscribe settled at once. */
  async function onSubscription(e) {
    const sub = parseSubscription(e);
    if (!sub || sub.provider !== key.pubkey || sub.subscriber !== e.pubkey) return;
    // the buyer's channels on this stream still served: an unsubscribe, or a new channel, closes them (their last vouchers collected)
    const was = Object.values(m.sales).filter((s) => s.stream === sub.stream_name && s.buyer === e.pubkey && !s.closing);
    const close = () => {
      for (const s of was) s.closing = true;
      return was.length ? collect(was).catch(log) : null;
    };
    if (sub.unsubscribe) return close();
    const price = m.prices[sub.stream_name];
    const c = sub.channel;
    if (!price || !c || !HEX32.test(String(c.id)) || Number(c.chain) !== config.chainId || !same(c.contract, config.channels)) return;
    if (m.sales[c.id]) return; // seen (a relay sends it again on each connect)
    const { channels } = await chain();
    const ch = await channels.readChannel(c.id);
    const signer = await bindingSigner(c.id, e.pubkey, c.binding);
    if (!ch || !same(ch.payee, vaultAddress) || !same(ch.token, config.token) || !same(ch.signer, signer) || ch.closed || ch.closeRequestedAt
      || ch.deposit - ch.settled < B(price)) return;
    close();
    m.sales[c.id] = { stream: sub.stream_name, buyer: e.pubkey, channel: c.id, signer: ch.signer, price, base: String(ch.settled),
      deposit: String(ch.deposit), settled: String(ch.settled), cumulative: String(ch.settled), signature: null, delivered: 0, closing: false };
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
    async load() { m = { prices: {}, sales: {}, buys: {}, ...((await db.get('market')) ?? {}) }; },

    // ── selling ──
    /** Whether our stream has a price. */
    priced: (stream) => !!m.prices[stream],
    /** Its listing for the announcement (predMetadata's market), or null when it is free. */
    listing: (stream) => (m.prices[stream] ? { chain: config.chainId, contract: config.channels, token: config.token, payee: vaultAddress,
      price: m.prices[stream] } : null),
    /** A price in wei on our stream (the caller re-announces it). */
    async sell(stream, wei) {
      if (!vaultAddress) throw new Error('No vault to be paid into.');
      m.prices[stream] = String(wei);
      await save();
    },
    /** Free again: no new deliveries; what buyers owe is still collected by the hourly pass. */
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
     * Buy a listed stream (`entry`: its verified catalog entry): the vault opens a channel to the payee with `deposit`
     * (wei; 100 observations by default), then the 34602 names it, with the identity's binding to our Nostr key. → its view
     */
    async buy(entry, deposit) {
      const l = listingOf(entry, config);
      if (!l) throw new Error('That stream is not for sale on the Satori contract.');
      const was = openBuy(entry.pubkey, entry.stream_name);
      if (was) return this.view(was.channel);
      const amount = deposit ?? l.price * BigInt(DEPOSIT_OBS);
      if (amount < l.price) throw new Error(`The deposit must cover at least one observation (${sat(l.price)} SATORI).`);
      const v = vault();
      if (!v) throw new Error('Unlock the vault first');
      const { channels } = await chain();
      let r;
      try {
        r = await channels.openChannel({ vault: v, identity: needIdentity(), payee: l.payee, deposit: amount });
      } catch (err) {
        throw new Error(channelErrorText(err), { cause: err });
      }
      m.buys[r.id] = { pubkey: entry.pubkey, stream: entry.stream_name, name: entry.name ?? '', channel: r.id, hash: r.hash, price: String(l.price),
        deposit: String(amount), cumulative: '0', seq: null, status: 'open', closeAt: null, at: t() };
      await save();
      const binding = signBinding(identity, r.id, key.pubkey);
      await sendKept([sign(subscriptionEvent({ stream: entry.stream_name, provider: entry.pubkey, subscriber: key.pubkey, now: t(),
        paymentChannel: { chain: config.chainId, contract: config.channels, id: r.id, binding } }))]); // kept until a relay takes it
      return this.view(r.id);
    },
    /**
     * A 34601 that may be a delivery to us of a stream we bought: verified, decrypted → the observation (parseObservation's
     * shape), and paid: the identity signs the next voucher (never past the deposit) and sends it (34603). Else null.
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
        const signature = await signVoucher(needIdentity(), { chainId: config.chainId, contract: config.channels, channelId: b.channel, cumulative: next });
        b.cumulative = String(next);
        await save(); // kept before it is sent: a reload never signs it again
        const voucher = { channel: b.channel, cumulative: String(next), signature };
        const content = await nip04Encrypt(key.secret, d.provider, paymentJson({ from: key.pubkey, to: d.provider, stream: d.stream_name,
          seq: d.seq + 1, amount: b.price, timestamp: t(), voucher }));
        sendKept([sign(paymentEvent({ stream: d.stream_name, provider: d.provider, seq: d.seq + 1, content, now: t() }))]).catch(log); // kept until a relay takes it
      } else {
        await save();
      }
      return { stream_name: d.stream_name, provider: d.provider, timestamp: d.timestamp, value, seq: d.seq, id: e.id };
    },
    /** Stop: the identity asks to close the channel (no Unlock), then Lite's unsubscribe; the refund comes after the 7-day grace period. → its view */
    async stop(pubkey, stream) {
      const b = openBuy(pubkey, stream);
      if (!b) throw new Error(`Not buying ${stream} from ${pubkey.slice(0, 8)}….`);
      const { channels } = await chain();
      try {
        await channels.requestClose(needIdentity(), b.channel);
      } catch (err) {
        throw new Error(channelErrorText(err), { cause: err });
      }
      const ch = await channels.readChannel(b.channel);
      Object.assign(b, { status: 'closing', closeAt: ch?.graceEndsAt ?? null });
      await save();
      await sendKept([sign(subscriptionEvent({ stream, provider: pubkey, subscriber: key.pubkey, now: t(), unsubscribe: true }))]);
      return this.view(b.channel);
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
     * no more deliveries, closed: gone), then one settleMany for every voucher above what is settled; each bought
     * channel whose grace period has ended is withdrawn (the refund to the vault).
     */
    async pass() {
      try {
        const sales = Object.values(m.sales);
        const closing = Object.values(m.buys).filter((b) => b.status === 'closing');
        if (!sales.length && !closing.length) return;
        const { channels, chainTime } = await chain();
        for (const s of sales) {
          const ch = await channels.readChannel(s.channel);
          if (!ch || ch.closed) {
            delete m.sales[s.channel];
            continue;
          }
          Object.assign(s, { deposit: String(ch.deposit), settled: String(ch.settled), closing: s.closing || !!ch.closeRequestedAt || !m.prices[s.stream] });
        }
        await collect(Object.values(m.sales));
        const at = closing.length ? await chainTime() : 0;
        for (const b of closing) {
          const ch = await channels.readChannel(b.channel);
          if (ch?.graceEndsAt != null) b.closeAt = ch.graceEndsAt;
          if (ch && !ch.closed && !(ch.graceEndsAt != null && ch.graceEndsAt <= at)) continue; // its grace period runs
          if (ch && !ch.closed) await channels.withdraw(needIdentity(), b.channel);
          delete m.buys[b.channel]; // refunded to the vault
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
        paid: sat(b.cumulative), left: sat(B(b.deposit) - B(b.cumulative)), received: b.seq, status: b.status, closeAt: b.closeAt };
    },
    /** nostr().market: what we sell (each buyer's channel, delivered, paid, settled) and what we buy. */
    status() {
      return {
        selling: Object.entries(m.prices).map(([stream, price]) => ({ stream, price: sat(price),
          buyers: salesOf(stream).map((s) => ({ pubkey: s.buyer, channel: s.channel, delivered: s.delivered, paid: sat(B(s.cumulative) - B(s.base)),
            settled: sat(s.settled), deposit: sat(s.deposit), closing: s.closing })) })),
        bought: Object.keys(m.buys).map((k) => this.view(k)),
        error: lastError,
      };
    },
  };
}
