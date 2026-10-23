// Payment channels on Base (docs/design/market.md#the-chain-client): PaymentChannels
// (contract/satori/contracts/channels/PaymentChannels.sol), the same address on every chain (config.js
// PAYMENT_CHANNELS). The wallet funds a channel and tops it up (Unlock); the alias signs its vouchers, asks to close
// and withdraws (the refund goes to the wallet, the payer); a seller's alias settles into the seller's wallet. The
// writes go through the chain's own write (index.js): simulated first, one at a time with the batch, padded, under
// the max fee. No UI, no database, no Nostr.
//
//   const channels = createChannels({ chain, config })
//   await channels.openChannel({ wallet, alias, payee, deposit }) → { id, hash, receipt, permit }
//   await signVoucher(alias, { chainId, channelId, cumulative }) / verifyVoucher({ …, signature, signer })
//   await channels.settleMany(alias, [{ id, cumulative, signature }]) → { hash, receipt, settled, skipped }
//   await channels.requestClose(alias, id) … CLOSE_GRACE_S … channels.withdraw(alias, id)
import {
  domainSeparator, encodeAbiParameters, hashTypedData, keccak256, parseEventLogs, parseSignature, recoverTypedDataAddress,
  toHex, zeroAddress,
} from 'viem';
import { channelsAbi, erc20PermitAbi, multicall3Abi, tokenAbi } from './abi.js';
import { DEFAULTS } from './config.js';
import { FeeCeilingError, HOOK_GAS, errorText, fmtUtc, revertName, same, toAccount, transferLock } from './index.js';

export const CLOSE_GRACE_S = 7 * 86400; // CLOSE_GRACE_PERIOD: requestClose → withdraw
export const MAX_AMOUNT = 2n ** 96n - 1n; // amounts are uint96 wei
/**
 * Gas per payment in a settleMany, over HOOK_GAS: each payment into a staked wallet runs the token's delegation hook
 * (measured on the fork: about 100,000 the first time, 70,000 after; docs/design/market.md), and a starved hook is skipped silently on
 * D6 (docs/issues/token-hook-gas-estimate.md). Unused gas is not charged.
 */
export const PAYMENT_GAS = 100_000n;
const PERMIT_S = 3600; // a permit's deadline: chain time + 1 h
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // secp256k1's order
const HALF_N = N >> 1n; // OpenZeppelin's ECDSA refuses s above it (the malleable twin)

const VOUCHER = { Voucher: [{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint96' }] };
const PERMIT = { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };

/** An error in plain words; `reason` is the contract's error name (or the client's own), viem's error in `cause`. */
export class ChannelError extends Error {
  constructor(message, { reason = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ChannelError';
    this.reason = reason;
  }
}

const PLAIN = {
  BadInput: "The channel's addresses or amount are not valid.",
  ChannelExists: 'A channel with this id already exists: open it with a new salt.',
  UnknownChannel: 'There is no such channel.',
  ChannelClosed: 'The channel is closed.',
  NotPayee: "Only the seller (the channel's payee) can do that.",
  NotPayer: 'Only the wallet that funded the channel can do that.',
  NotPayerOrSigner: "Only the channel's wallet or alias can do that.",
  BadSignature: "The voucher's signature isn't the channel's signer's.",
  NothingToSettle: 'Nothing new to settle: the voucher pays no more than is already paid.',
  CloseNotRequested: 'No close was asked for this channel.',
  CloseNotReady: "The 7-day grace period after the close request hasn't ended yet.",
  UnsupportedToken: "The token takes a fee on transfer, which channels can't hold.",
  SafeERC20FailedOperation: 'The token refused the transfer.',
  Locked: "The wallet's SATORI can't be sent now: it is staked, or it predicted by hand this round or the last.",
  ERC20InsufficientBalance: 'Not enough SATORI in the wallet.',
  ERC20InsufficientAllowance: "The channel contract wasn't allowed to take the deposit.",
  HookFailedWithoutReason: 'The transaction ran out of gas; try again.',
};

/** Any error in a line: the contract's (or the token's) reason in plain words, else viem's short message. */
export function channelErrorText(err) {
  if (err instanceof ChannelError || err instanceof FeeCeilingError) return err.message;
  return PLAIN[revertName(err)] ?? errorText(err);
}
const plain = (err) => (err instanceof ChannelError || err instanceof FeeCeilingError ? err
  : new ChannelError(channelErrorText(err), { reason: revertName(err), cause: err }));

function amountOf(x, what = 'The amount', { positive = false } = {}) {
  if (typeof x !== 'bigint' || x < (positive ? 1n : 0n) || x > MAX_AMOUNT) {
    throw new ChannelError(`${what} must be a bigint of wei from ${positive ? 1 : 0} to 2^96 − 1.`, { reason: 'BadInput' });
  }
  return x;
}

/** keccak256(abi.encode(payer, payee, token, signer, salt)): the contract's computeChannelId. */
export const channelIdOf = ({ payer, payee, token, signer, salt }) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
  [payer, payee, token, signer, salt]));

/** 32 random bytes: a channel's id is never reused, even after it closes. */
export const newSalt = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

/** The EIP-712 voucher "channel `channelId` owes its payee `cumulative` in all", under the contract's domain. */
export function voucherTypedData({ chainId, channelId, cumulative, contract = DEFAULTS.channels }) {
  return {
    domain: { name: 'PaymentChannels', version: '1', chainId, verifyingContract: contract },
    types: VOUCHER, primaryType: 'Voucher', message: { channelId, cumulativeAmount: amountOf(cumulative) },
  };
}
/** Its digest: the contract's voucherDigest(channelId, cumulative). */
export const voucherDigest = (v) => hashTypedData(voucherTypedData(v));

/** A voucher signed by `key` (the alias's signer, inside it; a viem account; a 0x key): 65 bytes, hex. No Unlock. */
export const signVoucher = (key, v) => toAccount(key).signTypedData(voucherTypedData(v));

/** What OpenZeppelin 5's ECDSA.tryRecover(hash, bytes) accepts: 65 bytes, v 27 or 28, 0 < r < n, 0 < s ≤ n/2. */
function ecdsaShape(signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  const r = BigInt(signature.slice(0, 66));
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = parseInt(signature.slice(130), 16);
  return (v === 27 || v === 28) && r > 0n && r < N && s > 0n && s <= HALF_N;
}

/**
 * Who signed a voucher, by ECDSA alone and under the contract's rules; null when the contract's ECDSA would refuse it.
 * A seller accepts only key signers (docs/plans/market.md): a contract's ERC-1271 answer can change.
 */
export async function recoverVoucherSigner({ signature, ...v }) {
  if (!ecdsaShape(signature)) return null;
  try {
    return await recoverTypedDataAddress({ ...voucherTypedData(v), signature });
  } catch {
    return null; // an r that is no point's x: ecrecover gives 0
  }
}
/** Whether `signer` signed this voucher for this channel, amount, chain and contract, as the contract's ECDSA checks it. */
export const verifyVoucher = async ({ signer, ...v }) => same(await recoverVoucherSigner(v), signer);

/** What `cumulative` would pay the payee now: min(cumulative, deposit) − settled, never below 0. */
export function dueOf({ deposit, settled }, cumulative) {
  const target = cumulative < deposit ? cumulative : deposit;
  return target > settled ? target - settled : 0n;
}

/** The Settled events of a receipt, this contract's only: [{ id, cumulative, paid, settled }]. */
export function settledOf(receipt, contract = DEFAULTS.channels) {
  return parseEventLogs({ abi: channelsAbi, eventName: 'Settled', logs: (receipt?.logs ?? []).filter((l) => same(l.address, contract)) })
    .map(({ args: a }) => ({ id: a.channelId, cumulative: a.cumulativeAmount, paid: a.paid, settled: a.settled }));
}

/** SATORI's transfer lock, said before anything is signed or sent (a funded channel needs SATORI the wallet can send). */
function lockError(lock) {
  if (!lock.locked) return null;
  const why = lock.indefinite ? "Your wallet is staked with this app, so it can't send SATORI"
    : `Your wallet's SATORI can't be sent until ${fmtUtc(lock.freeAt)} (round ${lock.untilRound + 1})`;
  return new ChannelError(`${why}: a channel needs SATORI the wallet can send.`, { reason: 'Locked' });
}

const addressOf = (key) => (typeof key === 'string' && key.length === 42 ? key : key?.evmAddress ?? toAccount(key).address);
/** The wallet's writes need it unlocked (its signer wipes the key at Lock). */
function unlocked(wallet) {
  if (wallet?.locked) throw new ChannelError('The wallet is locked: Unlock it first.', { reason: 'WalletLocked' });
  return toAccount(wallet);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The channel client on a chain made by createChain (index.js), whose queue, pad and max fee its writes share.
 * `settle`: how long to wait for an approve to show on a load-balanced RPC (as after Stake: 5 × 1 s).
 * Keys per call, as index.js: our signers, viem accounts or 0x keys. Amounts are bigint wei.
 */
export function createChannels({ chain, config = DEFAULTS, settle = { tries: 5, ms: 1000 } }) {
  const { client, write } = chain;
  const at = config.channels;
  const ch = (functionName, args = []) => ({ address: at, abi: channelsAbi, functionName, args });
  const erc20 = (token) => (functionName, args = []) => ({ address: token, abi: erc20PermitAbi, functionName, args });
  const satori = (functionName, args = []) => ({ address: config.token, abi: tokenAbi, functionName, args });
  const run = (fn) => async (...args) => { try { return await fn(...args); } catch (err) { throw plain(err); } };

  /** SATORI only: transferLockedUntil(wallet) vs the round (the token's rule, index.js transferLock). */
  async function checkLock(wallet, token) {
    if (!same(token, config.token)) return;
    const [lockedUntil, round] = await client.multicall({ allowFailure: false,
      contracts: [satori('transferLockedUntil', [wallet]), satori('getCurrentRound')] });
    const err = lockError(transferLock(Number(lockedUntil), Number(round)));
    if (err) throw err;
  }

  /**
   * An ERC-2612 permit for `value` to the channel contract, signed by `account`; null when the token has none. The
   * domain is ERC-5267's eip712Domain(), else name() and version "1", and only if it hashes to DOMAIN_SEPARATOR().
   */
  async function permitFor(account, token, value) {
    const t = erc20(token);
    const [nonce, d, separator, name, now] = await client.multicall({ allowFailure: true, contracts: [
      t('nonces', [account.address]), t('eip712Domain'), t('DOMAIN_SEPARATOR'), t('name'),
      { address: config.multicall3, abi: multicall3Abi, functionName: 'getCurrentBlockTimestamp' }] });
    if (nonce.status !== 'success' || separator.status !== 'success') return null;
    let domain = null;
    if (d.status === 'success') {
      const [fields, n, version, chainId, verifyingContract, salt] = d.result;
      const has = (bit) => (Number(fields) & bit) !== 0;
      domain = { ...(has(1) && { name: n }), ...(has(2) && { version }), ...(has(4) && { chainId: Number(chainId) }),
        ...(has(8) && { verifyingContract }), ...(has(16) && { salt }) };
    } else if (name.status === 'success') {
      domain = { name: name.result, version: '1', chainId: config.chainId, verifyingContract: token };
    }
    if (!domain || domainSeparator({ domain }) !== separator.result) return null;
    const deadline = (now.status === 'success' ? now.result : BigInt(Math.floor(Date.now() / 1000))) + BigInt(PERMIT_S);
    const signature = await account.signTypedData({ domain, types: PERMIT, primaryType: 'Permit',
      message: { owner: account.address, spender: at, value, nonce: nonce.result, deadline } });
    const { r, s, v, yParity } = parseSignature(signature);
    return { deadline, v: Number(v ?? 27n + BigInt(yParity)), r, s };
  }

  /** approve(channels, value) when the allowance is short, then wait until the RPC shows it. → the approve's hash, or null */
  async function approveFor(account, token, value, opts) {
    const allowance = () => client.readContract(erc20(token)('allowance', [account.address, at]));
    if (await allowance() >= value) return null;
    const { hash } = await write(account, erc20(token)('approve', [at, value]), opts);
    for (let i = 0; i < settle.tries && await allowance().catch(() => 0n) < value; i++) await sleep(settle.ms);
    return hash;
  }

  async function readChannel(id) {
    const c = await client.readContract(ch('getChannel', [id]));
    if (c.payer === zeroAddress) return null;
    const asked = Number(c.closeRequestedAt);
    return { id, payer: c.payer, payee: c.payee, token: c.token, signer: c.signer, deposit: c.deposit, settled: c.settled,
      closeRequestedAt: asked || null, closed: c.closed, graceEndsAt: asked ? asked + CLOSE_GRACE_S : null };
  }

  return {
    /** A channel as the contract holds it (amounts bigint wei, times unix seconds), or null for an id never opened. */
    readChannel: run(readChannel),

    /**
     * The wallet opens a channel to `payee` (the seller's wallet) with `deposit` of `token` (SATORI by default): payer = the
     * wallet, signer = the alias. One openWithPermit; a token without a permit: approve, then open. SATORI's transfer
     * lock is checked first. opts: as index.js's writes (onSent). → { id, hash, receipt, permit, approve? }
     */
    openChannel: run(async ({ wallet, alias, payee, deposit, token = config.token, salt = newSalt() }, opts = {}) => {
      amountOf(deposit, 'The deposit', { positive: true });
      const account = unlocked(wallet);
      const [payer, signer] = [account.address, addressOf(alias)];
      const id = channelIdOf({ payer, payee, token, signer, salt });
      await checkLock(payer, token);
      const permit = await permitFor(account, token, deposit);
      if (permit) {
        const { hash, receipt } = await write(account, ch('openWithPermit',
          [payer, payee, token, signer, deposit, salt, permit.deadline, permit.v, permit.r, permit.s]), opts);
        return { id, hash, receipt, permit: true };
      }
      const approve = await approveFor(account, token, deposit, opts);
      const { hash, receipt } = await write(account, ch('open', [payer, payee, token, signer, deposit, salt]), opts);
      return { id, hash, receipt, permit: false, ...(approve && { approve }) };
    }),

    /** The wallet adds `amount` (the contract has no permit form: approve first when short). → { hash, receipt, approve? } */
    topUp: run(async (wallet, id, amount, opts = {}) => {
      amountOf(amount, 'The amount', { positive: true });
      const account = unlocked(wallet);
      const c = await readChannel(id);
      if (!c) throw new ChannelError(PLAIN.UnknownChannel, { reason: 'UnknownChannel' });
      if (c.closed) throw new ChannelError(PLAIN.ChannelClosed, { reason: 'ChannelClosed' });
      await checkLock(account.address, c.token);
      const approve = await approveFor(account, c.token, amount, opts);
      return { ...await write(account, ch('topUp', [id, amount]), opts), ...(approve && { approve }) };
    }),

    /** The alias (or the wallet) starts the 7-day grace period; asking again doesn't restart it. */
    requestClose: run((alias, id, opts) => write(alias, ch('requestClose', [id]), opts)),
    /** The wallet takes its close request back (only the payer may; it moves no tokens, so a staked wallet can). */
    cancelClose: run((wallet, id, opts) => write(unlocked(wallet), ch('cancelClose', [id]), opts)),
    /** After the grace period, the alias (or the wallet) sends what was not settled back to the wallet. */
    withdraw: run((alias, id, opts) => write(alias, ch('withdraw', [id]), opts)),

    /** The seller's alias settles one voucher into the payee. → { hash, receipt, settled } */
    settle: run(async (alias, id, cumulative, signature, opts) => {
      const r = await write(alias, ch('settle', [id, amountOf(cumulative), signature]), opts);
      return { ...r, settled: settledOf(r.receipt, at) };
    }),

    /**
     * The seller's alias settles many vouchers in one transaction ([{ id, cumulative, signature }]), only those that
     * would pay: the rest come back in `skipped` ({ id, reason: 'unknown' | 'closed' | 'nothing-due' | 'bad-signature' }),
     * and with none left nothing is sent. Padded per payment (PAYMENT_GAS). → { hash, receipt, settled, skipped }
     */
    settleMany: run(async (alias, entries, opts = {}) => {
      entries.forEach((e) => amountOf(e.cumulative));
      const held = entries.length
        ? await client.multicall({ allowFailure: false, contracts: entries.map((e) => ch('getChannel', [e.id])) }) : [];
      const keep = [];
      const skipped = [];
      for (const [i, e] of entries.entries()) {
        const c = held[i];
        const reason = c.payer === zeroAddress ? 'unknown' : c.closed ? 'closed' : dueOf(c, e.cumulative) === 0n ? 'nothing-due'
          : !(await verifyVoucher({ chainId: config.chainId, contract: at, channelId: e.id, cumulative: e.cumulative,
            signature: e.signature, signer: c.signer })) ? 'bad-signature' : null;
        if (reason) skipped.push({ id: e.id, reason });
        else keep.push(e);
      }
      if (!keep.length) return { hash: null, receipt: null, settled: [], skipped };
      const r = await write(alias, ch('settleMany', [keep.map((e) => e.id), keep.map((e) => e.cumulative), keep.map((e) => e.signature)]),
        { ...opts, pad: HOOK_GAS + BigInt(keep.length) * PAYMENT_GAS });
      return { ...r, settled: settledOf(r.receipt, at), skipped };
    }),
  };
}
