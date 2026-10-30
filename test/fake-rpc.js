// Test double (never imported by the app): a tiny chain behind JSON-RPC, for
// viem's `custom` transport (unit tests) and for the e2e's /rpc route.
// Contracts are { address: { abi, fns: { name(args, ctx) → result } } }; a
// handler calls revert('Name') to revert with that custom error (or with no
// data for a bare revert). ctx = { from, write, value, now, round, hour }:
// handlers change state only when ctx.write (a mined transaction).
// Sent transactions go through a pool by sender and nonce, as a node's: mined at
// once (state.mine), or held until release(); a held one is replaced by one with
// the same nonce and fees 10 % higher (else 'replacement transaction underpriced'),
// and the node then forgets it.
import {
  custom, decodeFunctionData, encodeErrorResult, encodeFunctionResult, keccak256, parseAbi, parseTransaction,
  recoverTransactionAddress, toHex,
} from 'viem';
import { multicall3Abi } from '../src/chain/abi.js';
import { DEFAULTS } from '../src/chain/config.js';

const MULTICALL3 = DEFAULTS.multicall3.toLowerCase();
const mc3 = [...multicall3Abi, ...parseAbi([ // the app's reads, and aggregate3, which viem's multicall sends
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])];

class Revert extends Error {}
export const revert = (name = '') => { throw Object.assign(new Revert(name || 'revert'), { errorName: name }); };
/** Solidity's Panic(uint256): 0x11 is an arithmetic underflow or overflow. */
export const panic = (code) => {
  const raw = encodeErrorResult({ abi: [{ type: 'error', name: 'Panic', inputs: [{ type: 'uint256', name: 'code' }] }], errorName: 'Panic', args: [BigInt(code)] });
  throw Object.assign(new Revert(`panic ${code}`), { errorName: 'Panic', raw });
};

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    Object.assign(this, { code, data });
  }
}

/**
 * @param {Record<string, {abi: any[], fns: Record<string, Function>}>} contracts
 * @param {{timestamp?: number, eth?: Record<string, bigint>, gasPrice?: bigint}} [opts]
 */
export function fakeRpc(contracts, { timestamp = 20741 * 86400 + 3600, eth = {}, gasPrice = 1_000_000n } = {}) {
  const byAddr = Object.fromEntries(Object.entries(contracts).map(([a, c]) => [a.toLowerCase(), c]));
  const balances = Object.fromEntries(Object.entries(eth).map(([a, v]) => [a.toLowerCase(), v]));
  const sent = []; // sent transactions: { from, to, functionName, args, value, hash, status, nonce, mined, replaced }
  const receipts = {};
  const txs = {}; // the node's transactions (pending or mined), as eth_getTransactionByHash answers
  const nonces = {}; // sender → its mined transactions (the 'latest' nonce)
  const pool = {}; // `${sender}:${nonce}` → { tx, from, hash, entry }: sent, not mined
  const blocks = [{ number: 0, timestamp }];
  const log = []; // every RPC method called
  const state = { down: false, tip: gasPrice, baseFee: 1n, mine: true }; // mine: false holds sent txs unmined (no receipt yet)

  const now = () => timestamp;
  const ctxOf = (from, write, value = 0n) => ({
    from: from?.toLowerCase(), write, value, now: now(), round: Math.floor(now() / 86400), hour: Math.floor(now() / 3600),
  });
  const errorData = (c, e) => {
    if (e.raw) return e.raw;
    if (!e.errorName) return '0x';
    try { return encodeErrorResult({ abi: c.abi, errorName: e.errorName }); } catch { return '0x'; }
  };

  function exec(to, data, ctx) {
    to = to.toLowerCase();
    if (to === MULTICALL3) {
      const { functionName, args } = decodeFunctionData({ abi: mc3, data });
      if (functionName === 'getEthBalance') {
        return encodeFunctionResult({ abi: mc3, functionName, result: balances[args[0].toLowerCase()] ?? 0n });
      }
      if (functionName === 'getCurrentBlockTimestamp') return encodeFunctionResult({ abi: mc3, functionName, result: BigInt(now()) });
      const result = args[0].map((c) => {
        try {
          return { success: true, returnData: exec(c.target, c.callData, ctx) };
        } catch (e) {
          if (!(e instanceof Revert) || !c.allowFailure) throw e;
          return { success: false, returnData: errorData(byAddr[c.target.toLowerCase()] ?? { abi: [] }, e) };
        }
      });
      return encodeFunctionResult({ abi: mc3, functionName: 'aggregate3', result });
    }
    const c = byAddr[to];
    if (!c) return '0x'; // an account: a plain transfer
    const { functionName, args = [] } = decodeFunctionData({ abi: c.abi, data });
    const fn = c.fns[functionName];
    if (!fn) throw new Error(`fakeRpc: ${functionName} not faked`);
    // ctx.exec: another contract called from this one (a Safe's execTransaction), as `from`
    const result = fn(args, { ...ctx, exec: (t, d, from) => exec(t, d, { ...ctx, from: from.toLowerCase() }) });
    const item = c.abi.find((i) => i.type === 'function' && i.name === functionName && i.inputs.length === args.length);
    return item.outputs.length ? encodeFunctionResult({ abi: c.abi, functionName, result }) : '0x';
  }

  function call(tx, write) {
    const value = BigInt(tx.value ?? 0);
    const from = tx.from?.toLowerCase();
    if (value > 0n && (balances[from] ?? 0n) < value) throw new RpcError(-32000, 'insufficient funds for gas * price + value');
    try {
      const out = exec(tx.to, tx.data ?? tx.input ?? '0x', ctxOf(from, write, value));
      if (write && value > 0n) {
        balances[from] -= value;
        balances[tx.to.toLowerCase()] = (balances[tx.to.toLowerCase()] ?? 0n) + value;
      }
      return out;
    } catch (e) {
      if (!(e instanceof Revert)) throw e;
      throw new RpcError(3, 'execution reverted', errorData(byAddr[tx.to.toLowerCase()] ?? { abi: [] }, e));
    }
  }

  const blockJson = (b) => ({
    number: toHex(b.number), hash: keccak256(toHex(b.number)), parentHash: '0x' + '00'.repeat(32),
    timestamp: toHex(b.timestamp), baseFeePerGas: toHex(state.baseFee), gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [],
    logs: [], logsBloom: '0x' + '00'.repeat(256), miner: '0x' + '00'.repeat(20), extraData: '0x', difficulty: '0x0',
    nonce: '0x0000000000000000', sha3Uncles: '0x' + '00'.repeat(32), size: '0x1', stateRoot: '0x' + '00'.repeat(32),
    receiptsRoot: '0x' + '00'.repeat(32), transactionsRoot: '0x' + '00'.repeat(32), mixHash: '0x' + '00'.repeat(32),
    totalDifficulty: '0x0', uncles: [],
  });

  async function handle(method, params = []) {
    log.push(method);
    if (state.down) throw new RpcError(-32603, 'upstream unavailable');
    switch (method) {
      case 'eth_chainId': return toHex(84532);
      case 'eth_blockNumber': return toHex(blocks.at(-1).number);
      case 'eth_getBlockByNumber': {
        const tag = params[0];
        const b = tag === 'latest' || tag === 'pending' ? blocks.at(-1) : blocks.find((x) => x.number === Number(tag));
        return b ? blockJson(tag === 'latest' || tag === 'pending' ? { ...b, timestamp: now() } : b) : null;
      }
      case 'eth_getBalance': return toHex(balances[params[0].toLowerCase()] ?? 0n);
      case 'eth_getTransactionCount': {
        const from = params[0].toLowerCase();
        let n = nonces[from] ?? 0;
        if (params[1] === 'pending') while (pool[`${from}:${n}`]) n++;
        return toHex(n);
      }
      case 'eth_gasPrice': return toHex(gasPrice);
      case 'eth_maxPriorityFeePerGas': return toHex(state.tip);
      case 'eth_call': return call(params[0], false);
      case 'eth_estimateGas': call(params[0], false); return '0x30000';
      case 'eth_sendRawTransaction': {
        const raw = params[0];
        const tx = parseTransaction(raw);
        const from = (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase();
        const hash = keccak256(raw);
        const nonce = Number(tx.nonce ?? 0);
        if (nonce < (nonces[from] ?? 0)) throw new RpcError(-32000, 'nonce too low');
        const key = `${from}:${nonce}`;
        const old = pool[key];
        if (old) { // a replacement: 10 % more on both fees, or refused
          const up = (a, b) => (b ?? 0n) * 100n >= (a ?? 0n) * 110n;
          if (!up(old.tx.maxFeePerGas, tx.maxFeePerGas) || !up(old.tx.maxPriorityFeePerGas, tx.maxPriorityFeePerGas)) {
            throw new RpcError(-32000, 'replacement transaction underpriced');
          }
          delete txs[old.hash];
          old.entry.replaced = true;
        }
        const c = byAddr[tx.to.toLowerCase()];
        const { functionName, args } = c ? decodeFunctionData({ abi: c.abi, data: tx.data ?? '0x' }) : {};
        const entry = { from, to: tx.to.toLowerCase(), functionName, args, value: tx.value ?? 0n, hash, status: null, nonce, mined: false,
          gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas };
        sent.push(entry);
        txs[hash] = {
          hash, from, to: tx.to, nonce: toHex(nonce), value: toHex(tx.value ?? 0n), gas: toHex(tx.gas ?? 0n),
          input: tx.data ?? '0x', type: '0x2', chainId: toHex(84532), maxFeePerGas: toHex(tx.maxFeePerGas ?? 0n),
          maxPriorityFeePerGas: toHex(tx.maxPriorityFeePerGas ?? 0n), v: '0x0', r: '0x1', s: '0x1', yParity: '0x0',
          blockHash: null, blockNumber: null, transactionIndex: null, accessList: [],
        };
        pool[key] = { tx, from, hash, entry };
        if (state.mine) mine();
        return hash;
      }
      case 'eth_getTransactionReceipt': return receipts[params[0]] ?? null;
      case 'eth_getTransactionByHash': return txs[params[0]] ?? null;
      default: throw new RpcError(-32601, `fakeRpc: ${method} not faked`);
    }
  }

  /** Mine every pooled transaction whose nonce is next for its sender, in nonce order, a block each. */
  function mine() {
    for (let again = true; again;) {
      again = false;
      for (const [key, p] of Object.entries(pool)) {
        if (Number(key.split(':')[1]) !== (nonces[p.from] ?? 0)) continue;
        delete pool[key];
        nonces[p.from] = (nonces[p.from] ?? 0) + 1;
        let status = '0x1';
        try { call({ ...p.tx, from: p.from }, true); } catch { status = '0x0'; }
        const block = { number: blocks.at(-1).number + 1, timestamp: now() };
        blocks.push(block);
        Object.assign(p.entry, { status: status === '0x1', mined: true });
        Object.assign(txs[p.hash], { blockHash: keccak256(toHex(block.number)), blockNumber: toHex(block.number), transactionIndex: '0x0' });
        receipts[p.hash] = {
          transactionHash: p.hash, transactionIndex: '0x0', blockHash: keccak256(toHex(block.number)), blockNumber: toHex(block.number),
          from: p.from, to: p.tx.to, cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: toHex(gasPrice),
          logs: [], logsBloom: '0x' + '00'.repeat(256), status, type: '0x2', contractAddress: null,
        };
        again = true;
      }
    }
  }

  /** viem's EIP-1193 request. */
  const request = ({ method, params }) => handle(method, params);

  /** One JSON-RPC body (a request or a batch) → the response body, as an HTTP node would answer. */
  async function http(body) {
    const one = async ({ id, method, params }) => {
      try {
        return { jsonrpc: '2.0', id, result: await handle(method, params) };
      } catch (e) {
        if (!(e instanceof RpcError)) throw e;
        return { jsonrpc: '2.0', id, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } };
      }
    };
    return Array.isArray(body) ? Promise.all(body.map(one)) : one(body);
  }

  return {
    transport: custom({ request }, { retryCount: 0 }),
    request,
    http,
    sent,
    log,
    state,
    eth: balances,
    get now() { return timestamp; },
    setTime(t) { timestamp = t; },
    advance(seconds) { timestamp += seconds; },
    /** Mine the held transactions (their receipts appear). */
    release() {
      mine();
      blocks.push({ number: blocks.at(-1).number + 1, timestamp }); // a new block: viem's receipt watchers look again
    },
    /** The pool: sent, not mined. */
    get pending() { return Object.values(pool).map((p) => p.entry); },
  };
}
