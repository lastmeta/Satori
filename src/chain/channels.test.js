// The channel client (docs/design/market.md#the-chain-client): the id and the voucher digest against values the deployed
// contract computed (test/fixtures/channels-vectors.json), vouchers signed and checked under the contract's ECDSA rules,
// and every write against a small fake of PaymentChannels and SATORI (below) over test/fake-rpc.js: who sends what, the
// lock check, the permit, the pads, the max fee, errors in plain words.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ContractFunctionExecutionError, ContractFunctionRevertedError, domainSeparator, encodeAbiParameters, encodeErrorResult,
  encodeEventTopics, hashTypedData, hexToBytes, keccak256, parseSignature, serializeSignature, toHex, zeroAddress, zeroHash,
} from 'viem';
import { privateKeyToAccount, publicKeyToAddress } from 'viem/accounts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { publicKey, evmAddress, signDigest } from '../keys/keys.js';
import { fakeRpc, revert } from '../../test/fake-rpc.js';
import { channelsAbi, erc20PermitAbi, tokenAbi } from './abi.js';
import { DEFAULTS } from './config.js';
import { createChain, HOOK_GAS, INDEFINITE, FeeCeilingError } from './index.js';
import {
  CLOSE_GRACE_S, MAX_AMOUNT, PAYMENT_GAS, ChannelError, channelErrorText, channelIdOf, createChannels, dueOf, newSalt,
  recoverVoucherSigner, settledOf, signVoucher, verifyVoucher, voucherDigest, voucherTypedData,
} from './channels.js';

const V = JSON.parse(readFileSync(new URL('../../test/fixtures/channels-vectors.json', import.meta.url), 'utf8'));
const E18 = 10n ** 18n;
const ROUND = 20741;
const CHAIN = 84532;
const N = secp256k1.CURVE.n;
const lc = (a) => a.toLowerCase();

const keyOf = (hex) => {
  const secret = hexToBytes(`0x${hex}`);
  return { evmAddress: evmAddress(publicKey(secret)), signDigest: vi.fn((h) => signDigest(secret, h)) };
};

describe('the channel id and the voucher, as the deployed contract computes them', () => {
  test('channelIdOf = computeChannelId (keccak256(abi.encode(payer, payee, token, signer, salt)))', () => {
    for (const v of V.ids) expect(channelIdOf(v)).toBe(v.id);
  });
  test('voucherDigest = the contract\'s voucherDigest; its domain is the contract\'s domainSeparator', () => {
    for (const d of V.digests) {
      expect(voucherDigest({ chainId: V.chainId, channelId: d.channelId, cumulative: BigInt(d.cumulative), contract: V.contract })).toBe(d.digest);
      expect(voucherDigest({ chainId: V.chainId, channelId: d.channelId, cumulative: BigInt(d.cumulative) })).toBe(d.digest); // the default contract
    }
    const td = voucherTypedData({ chainId: CHAIN, channelId: V.ids[0].id, cumulative: 1n });
    expect(domainSeparator({ domain: td.domain })).toBe(V.domainSeparator);
    expect(td).toEqual({
      domain: { name: 'PaymentChannels', version: '1', chainId: CHAIN, verifyingContract: DEFAULTS.channels },
      types: { Voucher: [{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint96' }] },
      primaryType: 'Voucher', message: { channelId: V.ids[0].id, cumulativeAmount: 1n },
    });
    expect(keccak256(toHex('Voucher(bytes32 channelId,uint96 cumulativeAmount)'))).toBe(V.voucherTypehash);
  });
  test('an amount is a uint96 in wei, as a bigint', () => {
    const at = (cumulative) => () => voucherTypedData({ chainId: CHAIN, channelId: zeroHash, cumulative });
    expect(at(MAX_AMOUNT)).not.toThrow();
    for (const bad of [-1n, MAX_AMOUNT + 1n, 1, '1']) expect(at(bad)).toThrow(/bigint/);
  });
  test('newSalt: 32 random bytes', () => {
    const [a, b] = [newSalt(), newSalt()];
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('vouchers: signed by the identity, checked by ECDSA as the contract checks them', () => {
  const identity = keyOf('11'.repeat(32));
  const v = { chainId: CHAIN, channelId: V.ids[0].id, cumulative: 24n * 10n ** 15n };
  const flipS = (sig) => { // the malleable twin: (r, n − s) with the other v; ecrecover takes it, OpenZeppelin refuses it
    const { r, s, yParity } = parseSignature(sig);
    return serializeSignature({ r, s: toHex(N - BigInt(s), { size: 32 }), yParity: 1 - yParity });
  };

  test('sign → recover: our signer (inside it, no key handed out) and a viem account sign the same 65 bytes', async () => {
    const sig = await signVoucher(identity, v);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(identity.signDigest).toHaveBeenCalledWith(hexToBytes(voucherDigest(v)));
    expect(await signVoucher(privateKeyToAccount(`0x${'11'.repeat(32)}`), v)).toBe(sig); // RFC 6979: deterministic
    expect(await signVoucher(`0x${'11'.repeat(32)}`, v)).toBe(sig);
    expect(await recoverVoucherSigner({ ...v, signature: sig })).toBe(identity.evmAddress);
    expect(await verifyVoucher({ ...v, signature: sig, signer: identity.evmAddress })).toBe(true);
    expect(await verifyVoucher({ ...v, signature: sig, signer: lc(identity.evmAddress) })).toBe(true);
  });
  test('verify refuses a wrong signer, channel, amount, chain or contract', async () => {
    const signature = await signVoucher(identity, v);
    const signer = identity.evmAddress;
    expect(await verifyVoucher({ ...v, signature, signer: keyOf('22'.repeat(32)).evmAddress })).toBe(false);
    expect(await verifyVoucher({ ...v, channelId: V.ids[1].id, signature, signer })).toBe(false);
    expect(await verifyVoucher({ ...v, cumulative: v.cumulative + 1n, signature, signer })).toBe(false);
    expect(await verifyVoucher({ ...v, chainId: 8453, signature, signer })).toBe(false);
    expect(await verifyVoucher({ ...v, contract: `0x${'ab'.repeat(20)}`, signature, signer })).toBe(false);
  });
  test('what the contract\'s ECDSA refuses, refused here too: high s, v 0/1, 64 bytes, junk', async () => {
    const signature = await signVoucher(identity, v);
    const signer = identity.evmAddress;
    const twin = flipS(signature);
    expect(await verifyVoucher({ ...v, signature: twin, signer })).toBe(false);
    expect(await recoverVoucherSigner({ ...v, signature: twin })).toBe(null);
    const v01 = signature.slice(0, 130) + (signature.endsWith('1b') ? '00' : '01');
    expect(await verifyVoucher({ ...v, signature: v01, signer })).toBe(false);
    const { r, s, yParity } = parseSignature(signature);
    const compact = r + ((BigInt(s) | (BigInt(yParity) << 255n)).toString(16).padStart(64, '0')); // EIP-2098
    expect(await verifyVoucher({ ...v, signature: compact, signer })).toBe(false);
    for (const junk of ['0x', '0x1234', `0x${'00'.repeat(65)}`, null, 42]) expect(await verifyVoucher({ ...v, signature: junk, signer })).toBe(false);
  });
});

describe('dueOf: min(cumulative, deposit) − settled, never below 0', () => {
  test.each([
    [{ deposit: 10n, settled: 0n }, 4n, 4n],
    [{ deposit: 10n, settled: 3n }, 4n, 1n],
    [{ deposit: 10n, settled: 3n }, 25n, 7n], // past the deposit: what it holds
    [{ deposit: 10n, settled: 4n }, 4n, 0n],
    [{ deposit: 10n, settled: 5n }, 4n, 0n], // an old voucher
    [{ deposit: 10n, settled: 10n }, 99n, 0n],
  ])('%o at %s → %s', (c, cumulative, due) => expect(dueOf(c, cumulative)).toBe(due));
});

// ---------------------------------------------------------------------------------------------------------------------
// A small PaymentChannels and SATORI with the rules the client depends on (PaymentChannels.sol; SatoriToken.sol's lock
// and its OpenZeppelin ERC20Permit), over fake-rpc.js. Handlers change state only when ctx.write.
const TOKEN = DEFAULTS.token;
const CH = DEFAULTS.channels;
const OTHER_TOKEN = `0x${'77'.repeat(20)}`; // any ERC-20: no lock, no permit
const tokenDomain = (token = TOKEN, version = '1') => ({ name: 'Satori', version, chainId: CHAIN, verifyingContract: token });
const PERMIT = { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
const HALF_N = N / 2n;
/** OpenZeppelin's ECDSA.tryRecover(hash, 65 bytes): null for what it refuses. */
function ecrecover(digest, sig) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return null;
  const { r, s, v } = { r: BigInt(sig.slice(0, 66)), s: BigInt(`0x${sig.slice(66, 130)}`), v: parseInt(sig.slice(130), 16) };
  if ((v !== 27 && v !== 28) || s > HALF_N || r === 0n || s === 0n) return null;
  try {
    return publicKeyToAddress(toHex(new secp256k1.Signature(r, s).addRecoveryBit(v - 27).recoverPublicKey(hexToBytes(digest)).toRawBytes(false)));
  } catch { return null; }
}
/** A revert with the error's arguments (fake-rpc.js encodes a name alone). */
const revertWith = (errorName, args) => {
  try { revert(errorName); } catch (e) { throw Object.assign(e, { raw: encodeErrorResult({ abi: channelsAbi, errorName, args }) }); }
};
const unique = (...abis) => [...new Map(abis.flat().map((i) => [`${i.type}:${i.name}`, i])).values()];

function fakeMarket({ eth = {} } = {}) {
  const s = {
    balance: {}, allowance: {}, nonces: {}, lock: {}, channels: {},
    erc5267: true, // eip712Domain()
    permit: true, // nonces / DOMAIN_SEPARATOR / permit
    domainVersion: '1', // what eip712Domain() says (DOMAIN_SEPARATOR is always version 1's)
  };
  const key = (o, sp) => `${lc(o)}:${lc(sp)}`;
  const bal = (a) => s.balance[lc(a)] ?? 0n;
  const move = (from, to, v) => { s.balance[lc(from)] = bal(from) - v; s.balance[lc(to)] = bal(to) + v; };
  const locked = (a, ctx) => { const l = s.lock[lc(a)] ?? 0; return l !== 0 && l >= ctx.round; };

  function pull(token, from, amount, ctx, permitted = null) {
    if (lc(token) === lc(TOKEN) && locked(from, ctx)) revert('Locked');
    if (bal(from) < amount) revertWith('ERC20InsufficientBalance', [from, bal(from), amount]);
    const allowance = permitted ?? s.allowance[key(from, CH)] ?? 0n;
    if (allowance < amount) revertWith('ERC20InsufficientAllowance', [CH, allowance, amount]);
    if (ctx.write) { move(from, CH, amount); s.allowance[key(from, CH)] = allowance - amount; }
  }
  const live = (id) => {
    const c = s.channels[id];
    if (!c) revert('UnknownChannel');
    if (c.closed) revert('ChannelClosed');
    return c;
  };
  const digest = (id, cum) => hashTypedData(voucherTypedData({ chainId: CHAIN, channelId: id, cumulative: cum }));
  const valid = (c, id, cum, sig) => lc(ecrecover(digest(id, cum), sig) ?? '') === lc(c.signer);
  const pay = (c, cum, ctx) => {
    const target = cum < c.deposit ? cum : c.deposit;
    const paid = target - c.settled;
    if (ctx.write) { c.settled = target; move(CH, c.payee, paid); }
  };
  const target = (c, cum) => (cum < c.deposit ? cum : c.deposit);
  function open([payer, payee, token, signer, deposit, salt], ctx, permitted) {
    if ([payer, payee, token, signer].some((a) => a === zeroAddress) || deposit === 0n) revert('BadInput');
    const id = channelIdOf({ payer, payee, token, signer, salt });
    if (s.channels[id]) revert('ChannelExists');
    pull(token, ctx.from, deposit, ctx, permitted);
    if (ctx.write) s.channels[id] = { payer: lc(payer), payee: lc(payee), token: lc(token), signer: lc(signer), deposit, settled: 0n, closeRequestedAt: 0n, closed: false };
    return id;
  }
  function finalize(c, ctx) {
    if (ctx.write) { c.closed = true; move(CH, c.payer, c.deposit - c.settled); }
  }

  const contracts = {
    [TOKEN]: { abi: unique(tokenAbi, erc20PermitAbi), fns: {
      balanceOf: ([a]) => bal(a),
      transferLockedUntil: ([a]) => s.lock[lc(a)] ?? 0,
      getCurrentRound: (_, ctx) => BigInt(ctx.round),
      approve: ([sp, v], ctx) => { if (ctx.write) s.allowance[key(ctx.from, sp)] = v; return true; }, // approving is not a transfer: never locked
      allowance: ([o, sp]) => s.allowance[key(o, sp)] ?? 0n,
      nonces: ([o]) => (s.permit ? s.nonces[lc(o)] ?? 0n : revert()),
      name: () => 'Satori',
      DOMAIN_SEPARATOR: () => (s.permit ? domainSeparator({ domain: tokenDomain() }) : revert()),
      eip712Domain: () => (s.erc5267 ? ['0x0f', 'Satori', s.domainVersion, BigInt(CHAIN), TOKEN, zeroHash, []] : revert()),
    } },
    [OTHER_TOKEN]: { abi: unique(erc20PermitAbi), fns: {
      allowance: ([o, sp]) => s.allowance[key(o, sp)] ?? 0n,
      approve: ([sp, v], ctx) => { if (ctx.write) s.allowance[key(ctx.from, sp)] = v; return true; },
      nonces: () => revert(), DOMAIN_SEPARATOR: () => revert(), eip712Domain: () => revert(), name: () => 'Other',
    } },
    [CH]: { abi: channelsAbi, fns: {
      open: (args, ctx) => open(args, ctx),
      openWithPermit: ([payer, payee, token, signer, deposit, salt, deadline, v, r, sv], ctx) => {
        let permitted = null; // the permit inside a try/catch: a bad one leaves the allowance as it is
        const owner = ctx.from;
        const nonce = s.nonces[owner] ?? 0n;
        const d = hashTypedData({ domain: tokenDomain(token), types: PERMIT, primaryType: 'Permit',
          message: { owner, spender: CH, value: deposit, nonce, deadline } });
        if (s.permit && lc(token) === lc(TOKEN) && BigInt(ctx.now) <= deadline
          && lc(ecrecover(d, serializeSignature({ r, s: sv, v: BigInt(v) })) ?? '') === owner) {
          permitted = deposit;
          if (ctx.write) { s.nonces[owner] = nonce + 1n; s.allowance[key(owner, CH)] = deposit; }
        }
        return open([payer, payee, token, signer, deposit, salt], ctx, permitted);
      },
      topUp: ([id, amount], ctx) => {
        const c = live(id);
        if (amount === 0n) revert('BadInput');
        pull(c.token, ctx.from, amount, ctx);
        if (ctx.write) c.deposit += amount;
      },
      settle: ([id, cum, sig], ctx) => {
        const c = live(id);
        if (target(c, cum) <= c.settled) revert('NothingToSettle');
        if (!valid(c, id, cum, sig)) revert('BadSignature');
        pay(c, cum, ctx);
      },
      settleMany: ([ids, cums, sigs], ctx) => {
        if (cums.length !== ids.length || sigs.length !== ids.length) revert('BadInput');
        let n = 0n;
        ids.forEach((id, i) => {
          const c = s.channels[id];
          if (!c || c.closed || target(c, cums[i]) <= c.settled || !valid(c, id, cums[i], sigs[i])) return;
          pay(c, cums[i], ctx);
          n++;
        });
        return n;
      },
      requestClose: ([id], ctx) => {
        const c = live(id);
        if (ctx.from !== c.payer && ctx.from !== c.signer) revert('NotPayerOrSigner');
        if (c.closeRequestedAt === 0n && ctx.write) c.closeRequestedAt = BigInt(ctx.now);
      },
      cancelClose: ([id], ctx) => {
        const c = live(id);
        if (ctx.from !== c.payer) revert('NotPayer');
        if (c.closeRequestedAt === 0n) revert('CloseNotRequested');
        if (ctx.write) c.closeRequestedAt = 0n;
      },
      withdraw: ([id], ctx) => {
        const c = live(id);
        if (ctx.from !== c.payer && ctx.from !== c.signer) revert('NotPayerOrSigner');
        if (c.closeRequestedAt === 0n) revert('CloseNotRequested');
        if (BigInt(ctx.now) < c.closeRequestedAt + BigInt(CLOSE_GRACE_S)) revert('CloseNotReady');
        finalize(c, ctx);
      },
      getChannel: ([id]) => {
        const c = s.channels[id];
        return c ? { ...c } : { payer: zeroAddress, deposit: 0n, payee: zeroAddress, settled: 0n, token: zeroAddress, closeRequestedAt: 0n, closed: false, signer: zeroAddress };
      },
    } },
  };
  const rpc = fakeRpc(contracts, { timestamp: ROUND * 86400 + 9 * 3600, eth });
  return { s, rpc };
}

const buyerI = keyOf('11'.repeat(32));
const buyerV = keyOf('22'.repeat(32));
const sellerI = keyOf('33'.repeat(32));
const sellerV = keyOf('44'.repeat(32));
const BI = lc(buyerI.evmAddress);
const BV = lc(buyerV.evmAddress);
const SI = lc(sellerI.evmAddress);
const SV = lc(sellerV.evmAddress);
const who = { [BI]: 'buyer identity', [BV]: 'buyer vault', [SI]: 'seller identity', [SV]: 'seller vault' };
const SALT = `0x${'5a'.repeat(32)}`;

let s, rpc, chain, channels;
const make = (opts = {}) => {
  chain = createChain({ config: DEFAULTS, transport: rpc.transport, pollingInterval: 1, settle: { tries: 5, ms: 1 }, ...opts });
  return createChannels({ chain, config: DEFAULTS, settle: { tries: 3, ms: 1 } });
};
beforeEach(() => {
  vi.clearAllMocks(); // the keys' signDigest counts
  ({ s, rpc } = fakeMarket({ eth: Object.fromEntries([BI, BV, SI, SV].map((a) => [a, E18])) }));
  s.balance[BV] = 5n * E18;
  channels = make();
});
const sentBy = () => rpc.sent.map((t) => [who[t.from] ?? t.from, t.functionName]);
const opened = (o = {}) => channels.openChannel({ vault: buyerV, identity: buyerI, payee: sellerV.evmAddress, deposit: 2n * E18, salt: SALT, ...o });
const voucher = (id, cumulative, key = buyerI) => signVoucher(key, { chainId: CHAIN, channelId: id, cumulative });

describe('openChannel: the vault funds it (Unlock), the identity signs for it', () => {
  test('one openWithPermit from the vault: payer = the vault, signer = the identity; the id is channelIdOf', async () => {
    const r = await opened();
    const id = channelIdOf({ payer: buyerV.evmAddress, payee: sellerV.evmAddress, token: TOKEN, signer: buyerI.evmAddress, salt: SALT });
    expect(r).toMatchObject({ id, permit: true, hash: rpc.sent[0].hash });
    expect(r.receipt.status).toBe('success');
    expect(sentBy()).toEqual([['buyer vault', 'openWithPermit']]);
    expect(rpc.sent[0].args.slice(0, 6)).toEqual([buyerV.evmAddress, sellerV.evmAddress, TOKEN, buyerI.evmAddress, 2n * E18, SALT]);
    expect(rpc.sent[0].gas).toBe(0x30000n + HOOK_GAS);
    expect(s.nonces[BV]).toBe(1n); // the permit was used
    expect(s.balance[BV]).toBe(3n * E18);
    expect(await channels.readChannel(id)).toEqual({ id, payer: buyerV.evmAddress, payee: sellerV.evmAddress, token: TOKEN,
      signer: buyerI.evmAddress, deposit: 2n * E18, settled: 0n, closeRequestedAt: null, closed: false, graceEndsAt: null });
  });
  test('the permit\'s domain from eip712Domain(), checked against DOMAIN_SEPARATOR: one that does not match falls back to approve + open', async () => {
    s.domainVersion = '2'; // a token that says one domain and signs under another
    const r = await opened();
    expect(r).toMatchObject({ permit: false, approve: rpc.sent[0].hash, hash: rpc.sent[1].hash });
    expect(sentBy()).toEqual([['buyer vault', 'approve'], ['buyer vault', 'open']]);
    expect(rpc.sent[0].args).toEqual([CH, 2n * E18]);
  });
  test('without eip712Domain: name() and version "1", when that is the token\'s DOMAIN_SEPARATOR', async () => {
    s.erc5267 = false;
    expect(await opened()).toMatchObject({ permit: true });
    expect(sentBy()).toEqual([['buyer vault', 'openWithPermit']]);
  });
  test('a token with no permit: approve, then open; an allowance already there: open alone', async () => {
    s.permit = false;
    expect(await opened()).toMatchObject({ permit: false });
    expect(sentBy()).toEqual([['buyer vault', 'approve'], ['buyer vault', 'open']]);
    rpc.sent.length = 0;
    s.allowance[`${BV}:${lc(CH)}`] = 2n * E18;
    const r = await opened({ salt: newSalt() });
    expect(r.approve).toBeUndefined();
    expect(sentBy()).toEqual([['buyer vault', 'open']]);
  });
  test('the lock: a vault staked with this app can\'t fund a channel; said plainly, before any signature or gas', async () => {
    s.lock[BV] = INDEFINITE;
    const err = await opened().catch((e) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect(err.message).toBe("Your vault is staked with this app, so it can't send SATORI: a channel needs SATORI the vault can send.");
    expect(err.reason).toBe('Locked');
    expect(rpc.sent).toHaveLength(0);
    expect(buyerV.signDigest).not.toHaveBeenCalled();
  });
  test('the lock after unstaking (or a hand prediction): until the round after it, with its date', async () => {
    s.lock[BV] = ROUND + 1;
    await expect(opened()).rejects.toThrow("Your vault's SATORI can't be sent until Oct 17, 00:00 UTC (round 20743): a channel needs SATORI the vault can send.");
    s.lock[BV] = ROUND - 1; // ended
    await opened();
    expect(sentBy()).toEqual([['buyer vault', 'openWithPermit']]);
  });
  test('another token: no lock to read, no permit (approve + open)', async () => {
    s.lock[BV] = INDEFINITE; // SATORI's lock says nothing about another token
    expect(await opened({ token: OTHER_TOKEN })).toMatchObject({ permit: false });
    expect(rpc.sent.map((t) => [who[t.from], t.to, t.functionName])).toEqual([['buyer vault', lc(OTHER_TOKEN), 'approve'], ['buyer vault', lc(CH), 'open']]);
  });
  test('a locked vault (the passphrase): Unlock first, nothing sent', async () => {
    const locked = { evmAddress: buyerV.evmAddress, locked: true, signDigest: () => { throw new Error('Locked'); } };
    await expect(opened({ vault: locked })).rejects.toThrow('The vault is locked: Unlock it first.');
    expect(rpc.sent).toHaveLength(0);
  });
  test('errors in plain words: too little SATORI; the same id twice; a deposit of 0', async () => {
    s.balance[BV] = E18;
    await expect(opened()).rejects.toThrow('Not enough SATORI in the vault.');
    s.balance[BV] = 5n * E18;
    await opened();
    const again = await opened().catch((e) => e);
    expect([again.message, again.reason]).toEqual(['A channel with this id already exists: open it with a new salt.', 'ChannelExists']);
    await expect(opened({ deposit: 0n })).rejects.toThrow(/deposit/i);
    expect(rpc.sent).toHaveLength(1);
  });
  test('the max fee: over the ceiling, refused as every write is (FeeCeilingError as it is), nothing sent', async () => {
    const capped = make({ maxFee: async () => 10n ** 9n });
    rpc.state.tip = 3n * 10n ** 9n;
    const err = await capped.openChannel({ vault: buyerV, identity: buyerI, payee: sellerV.evmAddress, deposit: E18 }).catch((e) => e);
    expect(err).toBeInstanceOf(FeeCeilingError);
    expect(rpc.sent).toHaveLength(0);
  });
});

describe('topUp and cancelClose (the vault), requestClose and withdraw (the identity; the refund to the vault)', () => {
  let id;
  beforeEach(async () => { ({ id } = await opened()); rpc.sent.length = 0; });

  test('topUp: approve the amount when the allowance is short, then topUp, both from the vault', async () => {
    const r = await channels.topUp(buyerV, id, E18);
    expect(sentBy()).toEqual([['buyer vault', 'approve'], ['buyer vault', 'topUp']]);
    expect(r).toMatchObject({ hash: rpc.sent[1].hash, approve: rpc.sent[0].hash });
    expect((await channels.readChannel(id)).deposit).toBe(3n * E18);
  });
  test('topUp: the same lock rule, said before anything is sent; an unknown channel in plain words', async () => {
    s.lock[BV] = INDEFINITE;
    await expect(channels.topUp(buyerV, id, E18)).rejects.toThrow(/staked with this app/);
    await expect(channels.topUp(buyerV, `0x${'99'.repeat(32)}`, E18)).rejects.toThrow('There is no such channel.');
    expect(rpc.sent).toHaveLength(0);
  });
  test('requestClose by the identity; withdraw refused until 7 days later, then the rest goes back to the vault', async () => {
    const t0 = rpc.now;
    await channels.requestClose(buyerI, id);
    expect(await channels.readChannel(id)).toMatchObject({ closeRequestedAt: t0, graceEndsAt: t0 + 7 * 86400 });
    const early = await channels.withdraw(buyerI, id).catch((e) => e);
    expect([early.message, early.reason]).toEqual(["The 7-day grace period after the close request hasn't ended yet.", 'CloseNotReady']);
    rpc.advance(7 * 86400);
    await channels.withdraw(buyerI, id);
    expect(sentBy()).toEqual([['buyer identity', 'requestClose'], ['buyer identity', 'withdraw']]);
    expect(s.balance[BV]).toBe(5n * E18);
    expect(s.balance[BI]).toBeUndefined();
    expect(await channels.readChannel(id)).toMatchObject({ closed: true });
    await expect(channels.requestClose(buyerI, id)).rejects.toThrow('The channel is closed.');
  });
  test('cancelClose: the vault only (a leaked identity must not hold a refund back)', async () => {
    await expect(channels.cancelClose(buyerV, id)).rejects.toThrow('No close was asked for this channel.');
    await channels.requestClose(buyerI, id);
    await expect(channels.cancelClose(buyerI, id)).rejects.toThrow('Only the vault that funded the channel can do that.');
    await channels.cancelClose(buyerV, id);
    expect(sentBy()).toEqual([['buyer identity', 'requestClose'], ['buyer vault', 'cancelClose']]);
    expect(await channels.readChannel(id)).toMatchObject({ closeRequestedAt: null, graceEndsAt: null });
  });
  test('someone else\'s identity can\'t close it', async () => {
    await expect(channels.requestClose(sellerI, id)).rejects.toThrow("Only the channel's vault or alias can do that.");
  });
});

describe('settle and settleMany: the seller\'s identity sends, the seller\'s vault is paid; padded for the hook', () => {
  let id;
  beforeEach(async () => { ({ id } = await opened()); rpc.sent.length = 0; });

  test('settle: paid into the payee; the estimate + HOOK_GAS; an old voucher or a forged one in plain words', async () => {
    const sig = await voucher(id, 24n * 10n ** 15n);
    const r = await channels.settle(sellerI, id, 24n * 10n ** 15n, sig);
    expect(r).toMatchObject({ hash: rpc.sent[0].hash, settled: [] }); // fake receipts carry no logs: settledOf below
    expect(sentBy()).toEqual([['seller identity', 'settle']]);
    expect(rpc.sent[0].gas).toBe(0x30000n + HOOK_GAS);
    expect(s.balance[SV]).toBe(24n * 10n ** 15n);
    await expect(channels.settle(sellerI, id, 24n * 10n ** 15n, sig)).rejects.toThrow('Nothing new to settle: the voucher pays no more than is already paid.');
    const forged = await voucher(id, E18, sellerI);
    await expect(channels.settle(sellerI, id, E18, forged)).rejects.toThrow("The voucher's signature isn't the channel's signer's.");
    expect(rpc.sent).toHaveLength(1);
  });
  test('settleMany: one tx with only what pays; the rest skipped with why; the pad grows with each payment', async () => {
    s.balance[BV] = 20n * E18;
    const { id: id2 } = await opened({ salt: newSalt() });
    const { id: closed } = await opened({ salt: newSalt() });
    await channels.requestClose(buyerI, closed);
    rpc.advance(7 * 86400);
    await channels.withdraw(buyerI, closed);
    const { id: paid } = await opened({ salt: newSalt() });
    await channels.settle(sellerI, paid, 5n, await voucher(paid, 5n));
    rpc.sent.length = 0;
    const unknown = `0x${'99'.repeat(32)}`;
    const entries = [
      { id, cumulative: 10n, signature: await voucher(id, 10n) },
      { id: unknown, cumulative: 10n, signature: await voucher(unknown, 10n) },
      { id: closed, cumulative: 10n, signature: await voucher(closed, 10n) },
      { id: paid, cumulative: 5n, signature: await voucher(paid, 5n) },
      { id: id2, cumulative: 10n, signature: await voucher(id2, 10n, sellerI) },
      { id: id2, cumulative: 3n * E18, signature: await voucher(id2, 3n * E18) }, // past its 2 SATORI: pays the 2
    ];
    const r = await channels.settleMany(sellerI, entries);
    expect(sentBy()).toEqual([['seller identity', 'settleMany']]);
    expect(rpc.sent[0].args).toEqual([[id, id2], [10n, 3n * E18], [entries[0].signature, entries[5].signature]]);
    expect(rpc.sent[0].gas).toBe(0x30000n + HOOK_GAS + 2n * PAYMENT_GAS);
    expect(r.skipped).toEqual([{ id: unknown, reason: 'unknown' }, { id: closed, reason: 'closed' }, { id: paid, reason: 'nothing-due' },
      { id: id2, reason: 'bad-signature' }]);
    expect(s.balance[SV]).toBe(5n + 10n + 2n * E18);
  });
  test('settleMany with nothing to pay sends nothing', async () => {
    const r = await channels.settleMany(sellerI, [{ id, cumulative: 0n, signature: await voucher(id, 0n) }]);
    expect(r).toEqual({ hash: null, receipt: null, settled: [], skipped: [{ id, reason: 'nothing-due' }] });
    expect(await channels.settleMany(sellerI, [])).toEqual({ hash: null, receipt: null, settled: [], skipped: [] });
    expect(rpc.sent).toHaveLength(0);
  });
  test('settledOf: the Settled events of a receipt, this contract\'s only', () => {
    const log = (address, channelId, cumulative, paid, settled) => ({
      address,
      topics: encodeEventTopics({ abi: channelsAbi, eventName: 'Settled', args: { channelId, payer: BV, payee: SV } }),
      data: encodeAbiParameters([{ type: 'uint96' }, { type: 'uint96' }, { type: 'uint96' }], [cumulative, paid, settled]),
    });
    const receipt = { logs: [log(CH, id, 10n, 10n, 10n), log(`0x${'ab'.repeat(20)}`, id, 99n, 99n, 99n), log(lc(CH), V.ids[0].id, 7n, 2n, 7n)] };
    expect(settledOf(receipt)).toEqual([{ id, cumulative: 10n, paid: 10n, settled: 10n }, { id: V.ids[0].id, cumulative: 7n, paid: 2n, settled: 7n }]);
  });
});

describe('readChannel', () => {
  test('an id never opened: null', async () => {
    expect(await channels.readChannel(zeroHash)).toBe(null);
  });
});

describe('errors in plain words (channelErrorText)', () => {
  const reverted = (abi, errorName, args) => new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi, data: encodeErrorResult({ abi, errorName, args }), functionName: 'settle' }),
    { abi, functionName: 'settle', args: [] });
  test.each([
    ['BadInput', "The channel's addresses or amount are not valid."],
    ['ChannelExists', 'A channel with this id already exists: open it with a new salt.'],
    ['UnknownChannel', 'There is no such channel.'],
    ['ChannelClosed', 'The channel is closed.'],
    ['NotPayee', "Only the seller (the channel's payee) can do that."],
    ['NotPayer', 'Only the vault that funded the channel can do that.'],
    ['NotPayerOrSigner', "Only the channel's vault or alias can do that."],
    ['BadSignature', "The voucher's signature isn't the channel's signer's."],
    ['NothingToSettle', 'Nothing new to settle: the voucher pays no more than is already paid.'],
    ['CloseNotRequested', 'No close was asked for this channel.'],
    ['CloseNotReady', "The 7-day grace period after the close request hasn't ended yet."],
    ['UnsupportedToken', "The token takes a fee on transfer, which channels can't hold."],
    ['SafeERC20FailedOperation', 'The token refused the transfer.', [TOKEN]],
    ['Locked', "The vault's SATORI can't be sent now: it is staked, or it predicted by hand this round or the last."],
    ['ERC20InsufficientBalance', 'Not enough SATORI in the vault.', [BV, 1n, 2n]],
    ['ERC20InsufficientAllowance', "The channel contract wasn't allowed to take the deposit.", [CH, 1n, 2n]],
    ['HookFailedWithoutReason', 'The transaction ran out of gas; try again.'],
  ])('%s', (name, words, args) => {
    expect(channelErrorText(reverted(channelsAbi, name, args))).toBe(words);
  });
  test('anything else: its first line; a ChannelError or the max fee\'s error as it is', () => {
    expect(channelErrorText(new Error('insufficient funds for gas\nmore'))).toBe('insufficient funds for gas');
    expect(channelErrorText(new ChannelError('plain'))).toBe('plain');
    expect(channelErrorText(new FeeCeilingError(3n, 2n))).toMatch(/above the max fee/);
  });
});
