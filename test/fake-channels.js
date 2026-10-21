// Test helper (never imported by the app): the payment-channel contract held in memory, behind channels.js's client API
// (src/chain/channels.js), with the real voucher check, for the market's tests (src/neuron/market.test.js, nostr.test.js).
import { keccak256, toHex } from 'viem';
import { DEFAULTS } from '../src/chain/config.js';
import { CLOSE_GRACE_S, ChannelError, verifyVoucher } from '../src/chain/channels.js';

/** The contract, held in memory: open (from an unlocked vault), read, settleMany (each voucher checked as the contract does), close, withdraw. */
export function fakeChannels(now) {
  const map = new Map();
  const calls = [];
  let n = 0;
  const api = {
    map, calls, refuse: null,
    async openChannel({ vault, identity, payee, deposit, token = DEFAULTS.token }) {
      calls.push('open');
      if (api.refuse) throw api.refuse;
      const id = keccak256(toHex(`channel-${++n}`));
      map.set(id, { id, payer: vault.evmAddress, payee, token, signer: identity.evmAddress, deposit, settled: 0n, closeRequestedAt: null, closed: false,
        graceEndsAt: null });
      return { id, hash: `0xopen${n}` };
    },
    async readChannel(id) { const c = map.get(id); return c ? { ...c } : null; },
    async settleMany(identity, entries) {
      calls.push(['settleMany', entries.length]);
      const settled = [];
      for (const e of entries) {
        const c = map.get(e.id);
        const ok = await verifyVoucher({ chainId: DEFAULTS.chainId, channelId: e.id, cumulative: e.cumulative, signature: e.signature, signer: c.signer });
        const target = e.cumulative < c.deposit ? e.cumulative : c.deposit;
        if (!ok || c.closed || target <= c.settled) continue;
        c.settled = target;
        settled.push({ id: e.id, cumulative: e.cumulative, paid: 0n, settled: target });
      }
      return { hash: '0xsettle', settled, skipped: [] };
    },
    async requestClose(identity, id) {
      calls.push('requestClose');
      const c = map.get(id);
      c.closeRequestedAt ??= now();
      c.graceEndsAt = c.closeRequestedAt + CLOSE_GRACE_S;
    },
    async withdraw(identity, id) {
      const c = map.get(id);
      if (now() < c.graceEndsAt) throw new ChannelError("The 7-day grace period after the close request hasn't ended yet.", { reason: 'CloseNotReady' });
      calls.push('withdraw');
      c.closed = true;
    },
  };
  return api;
}
