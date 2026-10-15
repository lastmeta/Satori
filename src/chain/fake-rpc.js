// Test double (never imported by the app): a tiny chain behind JSON-RPC, for
// viem's `custom` transport (unit tests) and for the e2e's /rpc route.
// Contracts are { address: { abi, fns: { name(args, ctx) → result } } }; a
// handler calls revert('Name') to revert with that custom error (or with no
// data for a bare revert). ctx = { from, write, value, now, round, hour }:
// handlers change state only when ctx.write (a mined transaction).
import {
  custom, decodeFunctionData, encodeErrorResult, encodeFunctionResult, keccak256, parseAbi, parseTransaction,
  recoverTransactionAddress, toHex,
} from 'viem';
import { multicall3Abi } from './abi.js';
import { DEFAULTS } from './config.js';

const MULTICALL3 = DEFAULTS.multicall3.toLowerCase();
const mc3 = [...multicall3Abi, ...parseAbi([ // the app's reads, and aggregate3, which viem's multicall sends
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])];

class Revert extends Error {}
export const revert = (name = '') => { throw Object.assign(new Revert(name || 'revert'), { errorName: name }); };

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
  const sent = []; // mined transactions: { from, to, functionName, args, value, hash, status }
  const receipts = {};
  const held = {}; // receipts of txs sent while state.mine is false
  const txs = {}; // sent transactions, as eth_getTransactionByHash answers
  const blocks = [{ number: 0, timestamp }];
  const log = []; // every RPC method called
  const state = { down: false, tip: gasPrice, baseFee: 1n, mine: true }; // mine: false holds sent txs unmined (no receipt yet)

  const now = () => timestamp;
  const ctxOf = (from, write, value = 0n) => ({
    from: from?.toLowerCase(), write, value, now: now(), round: Math.floor(now() / 86400), hour: Math.floor(now() / 3600),
  });
  const errorData = (c, e) => {
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
    const result = fn(args, ctx);
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
      case 'eth_getTransactionCount': return toHex(sent.filter((s) => s.from === params[0].toLowerCase()).length);
      case 'eth_gasPrice': return toHex(gasPrice);
      case 'eth_maxPriorityFeePerGas': return toHex(state.tip);
      case 'eth_call': return call(params[0], false);
      case 'eth_estimateGas': call(params[0], false); return '0x30000';
      case 'eth_sendRawTransaction': {
        const raw = params[0];
        const tx = parseTransaction(raw);
        const from = (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase();
        const hash = keccak256(raw);
        let status = '0x1';
        try { call({ ...tx, from }, true); } catch { status = '0x0'; }
        const block = { number: blocks.at(-1).number + 1, timestamp: now() };
        blocks.push(block);
        const c = byAddr[tx.to.toLowerCase()];
        const { functionName, args } = c ? decodeFunctionData({ abi: c.abi, data: tx.data ?? '0x' }) : {};
        sent.push({ from, to: tx.to.toLowerCase(), functionName, args, value: tx.value ?? 0n, hash, status: status === '0x1',
          gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
        txs[hash] = {
          hash, from, to: tx.to, nonce: toHex(tx.nonce ?? 0), value: toHex(tx.value ?? 0n), gas: toHex(tx.gas ?? 0n),
          input: tx.data ?? '0x', type: '0x2', chainId: toHex(84532), maxFeePerGas: toHex(tx.maxFeePerGas ?? 0n),
          maxPriorityFeePerGas: toHex(tx.maxPriorityFeePerGas ?? 0n), v: '0x0', r: '0x1', s: '0x1', yParity: '0x0',
          blockHash: null, blockNumber: null, transactionIndex: null, accessList: [],
        };
        (state.mine ? receipts : held)[hash] = {
          transactionHash: hash, transactionIndex: '0x0', blockHash: keccak256(toHex(block.number)), blockNumber: toHex(block.number),
          from, to: tx.to, cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: toHex(gasPrice),
          logs: [], logsBloom: '0x' + '00'.repeat(256), status, type: '0x2', contractAddress: null,
        };
        return hash;
      }
      case 'eth_getTransactionReceipt': return receipts[params[0]] ?? null;
      case 'eth_getTransactionByHash': return txs[params[0]] ?? null;
      default: throw new RpcError(-32601, `fakeRpc: ${method} not faked`);
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
      Object.assign(receipts, held);
      for (const k of Object.keys(held)) delete held[k];
      blocks.push({ number: blocks.at(-1).number + 1, timestamp }); // a new block: viem's receipt watchers look again
    },
  };
}
