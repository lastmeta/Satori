// A connected wallet (docs/design/wallets.md#a-connected-wallet): the person's own wallet app, reached through its
// EIP-1193 provider, as the dapp connects one (contract/satori-ui/src/hooks/useWallet.ts). No secret of the wallet's
// is ever in the app: each signature is asked of the wallet app, which asks the person.
//   const found = await findWallets()                 // [{ rdns, name, provider }]: EIP-6963, else window.ethereum
//   const address = await requestAddress(provider)    // eth_requestAccounts: the wallet's chosen account
//   const signature = await signText(provider, address, text)   // personal_sign, checked: it recovers to `address`
//   const wallet = connectedWallet({ address, name, provider })  // what the chain module signs with (chain/index.js)
import { getAddress, isAddress, recoverMessageAddress, toHex } from 'viem';

export const INJECTED = 'injected';
export const DECLINED = 'Declined in the wallet app.';
/** A wallet app's no (EIP-1193 4001) in one line; anything else as it was. */
const ask = (provider, args) => provider.request(args).catch((err) => {
  throw err?.code === 4001 ? Object.assign(new Error(DECLINED), { code: 4001 }) : err;
});
export const NO_WALLET = 'No wallet in this browser: install one, such as MetaMask, or open this page in your wallet app\'s browser.';
/** The requests that need the person's account: the wallet app is asked for its accounts first. */
const SIGNING = new Set(['eth_sendTransaction', 'eth_signTypedData_v4', 'personal_sign', 'eth_sign']);

/**
 * The wallets in this browser: each that announces itself (EIP-6963: name and rdns), else the injected
 * window.ethereum as "Browser wallet". `wait` ms for the announcements, which come at once on the request.
 */
export async function findWallets({ win = globalThis.window, wait = 250 } = {}) {
  if (!win) return [];
  const found = new Map();
  const announce = (e) => {
    const { info, provider } = e?.detail ?? {};
    if (info?.rdns && provider?.request && !found.has(info.rdns)) found.set(info.rdns, { rdns: info.rdns, name: info.name || info.rdns, provider });
  };
  win.addEventListener('eip6963:announceProvider', announce);
  win.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((r) => setTimeout(r, wait));
  win.removeEventListener('eip6963:announceProvider', announce);
  const list = [...found.values()];
  if (!list.length && win.ethereum?.request) list.push({ rdns: INJECTED, name: 'Browser wallet', provider: win.ethereum });
  return list;
}

/** The wallet's chosen account (eth_requestAccounts asks the person once per site), EIP-55. */
export async function requestAddress(provider) {
  const [a] = (await ask(provider, { method: 'eth_requestAccounts' })) ?? [];
  if (!isAddress(a ?? '', { strict: false })) throw new Error('The wallet app gave no account.');
  return getAddress(a);
}

/** `text` signed by the wallet (personal_sign), checked: it must recover to `address`. → the signature */
export async function signText(provider, address, text) {
  const signature = await ask(provider, { method: 'personal_sign', params: [toHex(text), address] });
  if (await recoverMessageAddress({ message: text, signature }) !== getAddress(address)) {
    throw new Error('The wallet app signed with another account.');
  }
  return signature;
}

/**
 * What the chain module signs with (chain/index.js toAccount: a JSON-RPC account over `provider`). Its provider asks
 * the wallet app for its accounts before each signature, so a wallet on another account is said plainly, not sent.
 */
export function connectedWallet({ address, name, provider }) {
  const guarded = {
    async request(args) {
      if (SIGNING.has(args?.method)) {
        const accounts = (await provider.request({ method: 'eth_requestAccounts' })) ?? [];
        if (!accounts.some((a) => a?.toLowerCase() === address.toLowerCase())) {
          throw new Error(`${name} is on another account: choose ${address} in it, then try again.`);
        }
      }
      return provider.request(args);
    },
  };
  return { evmAddress: getAddress(address), name, provider: guarded, connected: true, locked: false, lock() {} };
}

/** The text a connected wallet signs to show the app's own keys (Backup): its address and the time. */
export const showKeysText = (address, at = Math.floor(Date.now() / 1000)) =>
  `Satori: show this app's keys\nwallet: ${getAddress(address)}\nissued: ${at}`;
