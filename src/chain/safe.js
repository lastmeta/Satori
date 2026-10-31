// A Safe (1.4.1) and Safe's transaction service (docs/design/safe.md): a transaction is proposed to the service with
// one owner's signature, the others sign it there, and any address executes it once enough have signed. The same queue
// app.safe.global shows. Nothing here sends a transaction: execTransaction goes through the chain's write.
//   const tx = safeTx({ safe, to, data, nonce })        // value 0, a call, no gas refund
//   const hash = safeTxHash(chainId, tx)
//   const sig = await signSafeTx(key, chainId, tx)      // the owner's EIP-712 signature
//   const service = safeService({ url, fetch })         // pending(safe, fromNonce), propose(...), confirm(hash, sig)
//   execArgs(tx, confirmations)                         // execTransaction's arguments, the signatures sorted by owner
import { concat, getAddress, hashTypedData, zeroAddress } from 'viem';
import { toAccount } from './index.js';
import { DEFAULTS } from './config.js';

export { safeAbi } from './abi.js';

/** Safe's transaction service for this build's chain (no key needed; CORS open). */
export const SAFE_SERVICE = DEFAULTS.safeService;


const TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' }, { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
  ],
};

/** A plain Safe transaction: a call (operation 0), no value, no gas refund. */
export const safeTx = ({ safe, to, data, nonce }) => ({ safe: getAddress(safe), to: getAddress(to), value: 0n, data, operation: 0, safeTxGas: 0n,
  baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: BigInt(nonce) });

const typed = (chainId, tx) => ({ domain: { chainId, verifyingContract: tx.safe }, types: TYPES, primaryType: 'SafeTx',
  message: { to: tx.to, value: tx.value, data: tx.data, operation: tx.operation, safeTxGas: tx.safeTxGas, baseGas: tx.baseGas,
    gasPrice: tx.gasPrice, gasToken: tx.gasToken, refundReceiver: tx.refundReceiver, nonce: tx.nonce } });

/** The hash the owners sign (the Safe's getTransactionHash). */
export const safeTxHash = (chainId, tx) => hashTypedData(typed(chainId, tx));

/** An owner's signature of `tx` (EIP-712; our signer by its digest, a connected wallet in its app). */
export const signSafeTx = (key, chainId, tx) => toAccount(key).signTypedData(typed(chainId, tx));

/** execTransaction's arguments: the confirmations' signatures concatenated, sorted by owner (the Safe requires it). */
export function execArgs(tx, confirmations) {
  const sigs = [...confirmations].sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1)).map((c) => c.signature);
  return [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, concat(sigs)];
}

/** The service: { pending(safe, fromNonce), propose(chainId, tx, sender, signature), confirm(hash, signature) }. */
export function safeService({ url = SAFE_SERVICE, fetch: get = globalThis.fetch.bind(globalThis) } = {}) {
  async function call(path, init) {
    const r = await get(`${url}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Safe's service refused it (${r.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return r.status === 204 || r.status === 201 ? null : r.json();
  }
  return {
    /** The Safe's transactions not yet executed, from `fromNonce` on, oldest first: [{ safeTxHash, nonce, to, data, confirmations: [{ owner, signature }] }]. */
    async pending(safe, fromNonce) {
      const j = await call(`/api/v2/safes/${getAddress(safe)}/multisig-transactions/?executed=false&nonce__gte=${fromNonce}&ordering=nonce&limit=50`);
      return (j?.results ?? []).filter((t) => !t.isExecuted).map((t) => ({ safeTxHash: t.safeTxHash, nonce: BigInt(t.nonce), to: getAddress(t.to),
        value: BigInt(t.value ?? 0), data: t.data ?? '0x', operation: Number(t.operation ?? 0),
        confirmations: (t.confirmations ?? []).map((c) => ({ owner: getAddress(c.owner), signature: c.signature })) }));
    },
    /** A new transaction, with its proposer's signature. */
    propose: (chainId, tx, sender, signature) => call(`/api/v2/safes/${tx.safe}/multisig-transactions/`, { method: 'POST', body: JSON.stringify({
      to: tx.to, value: '0', data: tx.data, operation: 0, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: zeroAddress, refundReceiver: zeroAddress,
      nonce: tx.nonce.toString(), contractTransactionHash: safeTxHash(chainId, tx), sender: getAddress(sender), signature, origin: 'Satori app' }) }),
    /** Another owner's signature of a proposed transaction. */
    confirm: (hash, signature) => call(`/api/v1/multisig-transactions/${hash}/confirmations/`, { method: 'POST', body: JSON.stringify({ signature }) }),
  };
}
