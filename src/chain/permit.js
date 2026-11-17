// ERC-2612 for any token (docs/design/base.md#vote, docs/design/market.md#the-chain-client): a permit signed by the owner,
// its EIP-712 domain read from the token and checked before anything is signed, and approve-then-wait where there is
// none. The payment channels (channels.js: openWithPermit) and the vote (index.js: hub.voteWithPermit) use them, as the
// dapp's lib/permit.ts.
import { domainSeparator, parseSignature } from 'viem';
import { erc20PermitAbi, multicall3Abi } from './abi.js';

const PERMIT_S = 3600; // a permit's deadline: chain time + 1 h
const PERMIT = { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * An ERC-2612 permit for `spender` to take `value` of `token` from `account` (a viem account: toAccount's), signed by it;
 * null when the token has none. The domain is ERC-5267's eip712Domain(), else name() and version "1", and only if it
 * hashes to DOMAIN_SEPARATOR(); the deadline is chain time + 1 h. A signer that refuses throws (the caller decides).
 * → { deadline, signature, v, r, s } (signature: the 65 bytes, for SATORI's bytes overload; v, r, s: ERC-2612's)
 */
export async function signPermit({ client, config }, account, { token, spender, value }) {
  const t = (functionName, args = []) => ({ address: token, abi: erc20PermitAbi, functionName, args });
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
    message: { owner: account.address, spender, value, nonce: nonce.result, deadline } });
  const { r, s, v, yParity } = parseSignature(signature);
  return { deadline, signature, v: Number(v ?? 27n + BigInt(yParity)), r, s };
}

/**
 * approve(spender, value) from `account` when its allowance is short, through the chain's write (`opts`: its onSent),
 * then wait until the RPC shows it (`settle`: as after Stake, 5 × 1 s). → the approve's hash, or null (none needed)
 */
export async function approveFor({ client, write, settle = { tries: 5, ms: 1000 } }, account, { token, spender, value }, opts) {
  const call = (functionName, args) => ({ address: token, abi: erc20PermitAbi, functionName, args });
  const allowance = () => client.readContract(call('allowance', [account.address, spender]));
  if (await allowance() >= value) return null;
  const { hash } = await write(account, call('approve', [spender, value]), opts);
  for (let i = 0; i < settle.tries && await allowance().catch(() => 0n) < value; i++) await sleep(settle.ms);
  return hash;
}
