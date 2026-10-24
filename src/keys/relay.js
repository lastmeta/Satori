// A connected wallet on a phone, or in any browser with no wallet in it (docs/design/wallets.md#a-connected-wallet):
// the dapp's two relay paths, ported as they are (contract/satori-ui/src/hooks/useWallet.ts getOrInitMetaMask,
// getOrInitWalletConnect; the same package versions). Each library loads only when its path is used.
//   const { provider, name } = await openRelay(kind, { config, projectId, connect: true })   // the person approves
//   const { provider, name } = await openRelay(kind, { config, projectId })   // a stored session, or null
import { isAddress } from 'viem';

export const METAMASK = 'metamask-connect';
export const WALLETCONNECT = 'walletconnect';
export const RELAYS = [METAMASK, WALLETCONNECT];

/** A relay has to reach back to this origin: a LAN address, localhost or a bare name cannot work (useWallet.ts isPublicHost). */
export function isPublicHost(host) {
  if (!host) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host === 'localhost' || host.endsWith('.local')) return false;
  if (host.startsWith('[') || host.includes(':')) return false;
  return host.includes('.');
}
export const PRIVATE_HOST = 'This address is on your private network, so a wallet app cannot reach it. Open the app at its public address, or in your wallet app\'s browser.';

const origin = () => globalThis.location?.origin ?? 'https://app.satorinet.io';
const hexChain = (id) => `0x${id.toString(16)}`;
let metamask = null; // the dapp's singletons: one client each, reused
let walletConnect = null;

async function metamaskClient(config) {
  metamask ??= (async () => {
    const { createEVMClient } = await import('@metamask/connect-evm');
    return createEVMClient({
      dapp: { name: 'Satori', url: origin(), iconUrl: `${origin()}/icon-192.png` },
      api: { supportedNetworks: { [hexChain(config.chainId)]: config.rpcUrl } },
      analytics: { enabled: false }, // nothing here needs MetaMask told how the app is used
      skipAutoAnnounce: true, // a real extension announces itself (EIP-6963); no duplicate
    });
  })().catch((err) => { metamask = null; throw err; });
  return metamask;
}

async function walletConnectClient(config, projectId) {
  if (!projectId) throw new Error('Other wallets need a WalletConnect project id (VITE_WALLETCONNECT_PROJECT_ID).');
  walletConnect ??= (async () => {
    const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
    return EthereumProvider.init({
      projectId, chains: [config.chainId], showQrModal: true, rpcMap: { [config.chainId]: config.rpcUrl },
      metadata: { name: 'Satori', description: 'The Satori app', url: origin(), icons: [`${origin()}/icon-192.png`] },
    });
  })().catch((err) => { walletConnect = null; throw err; });
  return walletConnect;
}

/**
 * The relay's EIP-1193 provider and the wallet's name. `connect`: ask the person (MetaMask opens to approve; others
 * by WalletConnect's code or wallet list); else only a session this browser kept (none: null), never a prompt.
 */
export async function openRelay(kind, { config, projectId, connect = false }) {
  if (connect && !isPublicHost(globalThis.location?.hostname)) throw new Error(PRIVATE_HOST);
  if (kind === METAMASK) {
    const client = await metamaskClient(config);
    if (connect) await client.connect({ chainIds: [hexChain(config.chainId)] });
    else if (!(client.status === 'connected' && client.getAccount())) return null;
    return { provider: client.getProvider(), name: 'MetaMask' };
  }
  if (kind === WALLETCONNECT) {
    const wc = await walletConnectClient(config, projectId);
    if (connect) await wc.enable();
    else if (!(wc.session && wc.accounts?.some((a) => isAddress(a, { strict: false })))) return null;
    return { provider: wc, name: wc.session?.peer?.metadata?.name || 'WalletConnect wallet' };
  }
  throw new Error(`Not a relay: ${kind}`);
}
