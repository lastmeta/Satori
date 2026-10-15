// Test double: a tiny in-memory Base Sepolia behind a viem `custom` transport.
// Contracts are {address: {abi, fns: {name(args, ctx) → result}}}; a handler
// throws revert('Name') to revert with a custom error. ctx = {from, write, value};
// handlers mutate state only when ctx.write (a mined transaction).
import {
  custom, decodeFunctionData, encodeErrorResult, encodeFunctionResult,
  keccak256, multicall3Abi, parseTransaction, recoverTransactionAddress, toHex,
} from 'viem';
import { ethBalanceAbi } from './abi.js';

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const mc3 = [...multicall3Abi, ...ethBalanceAbi];

export class Revert extends Error {}
export const revert = (name) => { throw Object.assign(new Revert(name), { errorName: name }); };

/**
 * @param {Record<string, {abi: any[], fns: Record<string, Function>}>} contracts
 * @param {{timestamp?: bigint, eth?: Record<string, bigint>}} [opts]
 */
export function fakeRpc(contracts, { timestamp = 20741n * 86400n + 3600n, eth = {} } = {}) {
  const byAddr = Object.fromEntries(Object.entries(contracts).map(([a, c]) => [a.toLowerCase(), c]));
  const sent = []; // {from, to, functionName, args}
  const receipts = {};
  const log = []; // every RPC method called

  function exec(to, data, ctx) {
    to = to.toLowerCase();
    if (to === MULTICALL3) {
      const { functionName, args } = decodeFunctionData({ abi: mc3, data });
      if (functionName === 'getEthBalance') {
        return encodeFunctionResult({ abi: mc3, functionName, result: eth[args[0].toLowerCase()] ?? 0n });
      }
      const result = args[0].map((c) => {
        try {
          return { success: true, returnData: exec(c.target, c.callData, ctx) };
        } catch (e) {
          if (!(e instanceof Revert) || !c.allowFailure) throw e;
          return { success: false, returnData: errorData(byAddr[c.target.toLowerCase()], e) };
        }
      });
      return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result });
    }
    const c = byAddr[to];
    if (!c) throw new Error(`fakeRpc: no contract at ${to}`);
    const { functionName, args = [] } = decodeFunctionData({ abi: c.abi, data });
    const fn = c.fns[functionName];
    if (!fn) throw new Error(`fakeRpc: ${functionName} not faked`);
    const result = fn(args, ctx);
    const out = c.abi.find((i) => i.name === functionName && i.inputs.length === args.length).outputs;
    return out.length ? encodeFunctionResult({ abi: c.abi, functionName, result }) : '0x';
  }

  const errorData = (c, e) => {
    try { return encodeErrorResult({ abi: c.abi, errorName: e.errorName }); } catch { return '0x'; }
  };

  function call(tx, write) {
    try {
      return exec(tx.to, tx.data ?? tx.input ?? '0x', { from: tx.from?.toLowerCase(), write });
    } catch (e) {
      if (!(e instanceof Revert)) throw e;
      throw Object.assign(new Error('execution reverted'), {
        code: 3, data: errorData(byAddr[tx.to.toLowerCase()], e),
      });
    }
  }

  const block = () => ({
    number: '0x10', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '00'.repeat(32),
    timestamp: toHex(timestamp), baseFeePerGas: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0',
    transactions: [], logs: [],
  });

  async function request({ method, params }) {
    log.push(method);
    switch (method) {
      case 'eth_chainId': return toHex(84532);
      case 'eth_blockNumber': return '0x10';
      case 'eth_getBlockByNumber': return block();
      case 'eth_getBalance': return toHex(eth[params[0].toLowerCase()] ?? 0n);
      case 'eth_getTransactionCount': return toHex(sent.filter((s) => s.from === params[0].toLowerCase()).length);
      case 'eth_maxPriorityFeePerGas': return '0x1';
      case 'eth_gasPrice': return '0x2';
      case 'eth_call': return call(params[0], false);
      case 'eth_estimateGas': call(params[0], false); return '0x30000';
      case 'eth_sendRawTransaction': {
        const raw = params[0];
        const tx = parseTransaction(raw);
        const from = (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase();
        const hash = keccak256(raw);
        let status = '0x1';
        try { call({ ...tx, from }, true); } catch { status = '0x0'; }
        const c = byAddr[tx.to.toLowerCase()];
        const { functionName, args } = c ? decodeFunctionData({ abi: c.abi, data: tx.data ?? '0x' }) : {};
        sent.push({ from, to: tx.to.toLowerCase(), data: tx.data, functionName, args, hash });
        receipts[hash] = {
          transactionHash: hash, transactionIndex: '0x0', blockHash: '0x' + '11'.repeat(32), blockNumber: '0x10',
          from, to: tx.to, cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1',
          logs: [], logsBloom: '0x' + '00'.repeat(256), status, type: '0x2', contractAddress: null,
        };
        return hash;
      }
      case 'eth_getTransactionReceipt': return receipts[params[0]] ?? null;
      case 'eth_getTransactionByHash': return null;
      default: throw new Error(`fakeRpc: ${method} not faked`);
    }
  }

  return { transport: custom({ request }, { retryCount: 0 }), sent, log, setTimestamp: (t) => { timestamp = t; } };
}
