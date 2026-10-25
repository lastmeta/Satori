// Referral (docs/design/base.md#referral-invite-links): the dapp's invite link, for the neuron.
import { getAddress, isAddress, zeroAddress } from 'viem';

/** The `ref` address of a URL's query string, or null (missing, not an address, the zero address). Only the first counts. */
export function referrerOf(search) {
  const ref = new URLSearchParams(search).get('ref');
  return ref && isAddress(ref) && getAddress(ref) !== zeroAddress ? ref : null;
}

/** The link that makes whoever opens it this wallet's referral. */
export const inviteLink = (origin, wallet) => (origin && wallet ? `${origin}/?ref=${wallet}` : '');

/** The invite link as shared from `tab`: from the game it opens the game (#game), else Home as usual. */
export const sharedLink = (link, tab) => (link && tab === 'game' ? `${link}#game` : link);

/**
 * Share a link: the device's share sheet when it has one, else copied. → 'shared' | 'cancelled' (the sheet closed with
 * no choice) | 'copied' | null (nothing to share, or no way to copy)
 */
export async function shareLink(link, nav = globalThis.navigator) {
  if (!link) return null;
  if (nav?.share) {
    try {
      await nav.share({ title: 'Satori app', url: link });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await nav.clipboard.writeText(link);
    return 'copied';
  } catch {
    return null;
  }
}
