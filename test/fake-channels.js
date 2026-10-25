// Test helper (never imported by the app): the payment-channel contract held in memory, behind channels.js's client API
// (src/chain/channels.js), with the real voucher check, for the market's tests (src/neuron/market.test.js, nostr.test.js).
import { keccak256, toHex } from 'viem';
import { DEFAULTS } from '../src/chain/config.js';
import { CLOSE_GRACE_S, ChannelError, verifyVoucher } from '../src/chain/channels.js';

/**
 * The contract, held in memory: open (from an unlocked wallet), read, settleMany (each voucher checked as the contract
 * does), close, cancelClose, topUp, withdraw, withdrawTo (counted as settled), setGrace, setPayout.
 */
export function fakeChannels(now) {
  const map = new Map();
  const calls = [];
  let n = 0;
  const api = {
    map, calls, refuse: null,
    async openChannel({ wallet, alias, payee, deposit, token = DEFAULTS.token }) {
      calls.push('open');
      if (api.refuse) throw api.refuse;
      const id = keccak256(toHex(`channel-${++n}`));
      map.set(id, { id, payer: wallet.evmAddress, payee, token, signer: alias.evmAddress, deposit, settled: 0n, closeRequestedAt: null, closed: false,
        grace: CLOSE_GRACE_S, payout: payee, graceEndsAt: null });
      return { id, hash: `0xopen${n}` };
    },
    async readChannel(id) {
      const c = map.get(id);
      return c ? { ...c, graceEndsAt: c.closeRequestedAt == null ? null : c.closeRequestedAt + c.grace } : null;
    },
    async settleMany(alias, entries) {
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
    async requestClose(alias, id) {
      calls.push('requestClose');
      const c = map.get(id);
      c.closeRequestedAt ??= now();
    },
    async cancelClose(wallet, id) {
      calls.push('cancelClose');
      map.get(id).closeRequestedAt = null;
    },
    async topUp(wallet, id, amount) {
      calls.push(['topUp', amount]);
      if (api.refuse) throw api.refuse;
      map.get(id).deposit += amount;
    },
    async withdraw(alias, id) {
      const c = map.get(id);
      if (c.closeRequestedAt == null || now() < c.closeRequestedAt + c.grace) {
        throw new ChannelError("The waiting period after the close request hasn't ended yet.", { reason: 'CloseNotReady' });
      }
      calls.push('withdraw');
      c.closed = true;
    },
    async withdrawTo(wallet, id, amount, to) {
      const c = map.get(id);
      if (c.closeRequestedAt == null || now() < c.closeRequestedAt + c.grace) {
        throw new ChannelError("The waiting period after the close request hasn't ended yet.", { reason: 'CloseNotReady' });
      }
      calls.push(['withdrawTo', amount, to ?? wallet.evmAddress]);
      c.settled += amount;
    },
    async setGrace(wallet, id, seconds) {
      const c = map.get(id);
      const isPayer = wallet.evmAddress === c.payer;
      const applied = (isPayer && seconds >= c.grace) || (!isPayer && seconds <= c.grace);
      calls.push(['setGrace', seconds, applied]);
      if (applied) c.grace = seconds;
      return { applied };
    },
    async setPayout(wallet, id, payout) {
      calls.push(['setPayout', payout]);
      map.get(id).payout = payout;
    },
  };
  return api;
}
