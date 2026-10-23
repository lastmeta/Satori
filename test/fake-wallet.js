// Test double (never imported by the app): a wallet app's EIP-1193 provider, as MetaMask exposes one, over a key of
// its own. It signs and sends its transactions to `transport` (a fake chain's), and says no when told to.
//   const app = fakeWallet({ key: '0x…', transport })   // app.provider: { request }
//   app.state: { chainId, knowsChain, reject, accounts }   app.calls: every method asked, in order
import { createWalletClient, hexToBigInt, hexToNumber } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const rpcError = (code, message) => Object.assign(new Error(message), { code });

export function fakeWallet({ key, transport, chainId = 84532, knowsChain = true }) {
  const account = privateKeyToAccount(key);
  const state = { chainId, knowsChain, reject: false, accounts: [account.address], added: [] };
  const calls = [];
  const sender = createWalletClient({ account, chain: baseSepolia, transport });
  const big = (h) => (h == null ? undefined : hexToBigInt(h));

  async function request({ method, params = [] }) {
    calls.push(method);
    const asks = ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'wallet_addEthereumChain'];
    if (state.reject && asks.includes(method)) throw rpcError(4001, 'User rejected the request.');
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts': return state.accounts;
      case 'eth_chainId': return `0x${state.chainId.toString(16)}`;
      case 'wallet_switchEthereumChain': {
        const id = hexToNumber(params[0].chainId);
        if (id === 84532 && !state.knowsChain) throw rpcError(4902, 'Unrecognized chain ID.');
        state.chainId = id;
        return null;
      }
      case 'wallet_addEthereumChain':
        state.added.push(params[0]);
        state.knowsChain = true;
        state.chainId = hexToNumber(params[0].chainId);
        return null;
      case 'personal_sign': return account.signMessage({ message: { raw: params[0] } });
      case 'eth_signTypedData_v4': return account.signTypedData(JSON.parse(params[1]));
      case 'eth_sendTransaction': {
        if (state.chainId !== 84532) throw rpcError(-32000, 'wrong chain');
        const tx = params[0];
        return sender.sendTransaction({ to: tx.to, data: tx.data, value: big(tx.value), gas: big(tx.gas),
          maxFeePerGas: big(tx.maxFeePerGas), maxPriorityFeePerGas: big(tx.maxPriorityFeePerGas) });
      }
      default: throw rpcError(4200, `${method} is not supported`);
    }
  }

  return { provider: { request }, address: account.address, state, calls };
}
