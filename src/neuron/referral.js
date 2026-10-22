// Referral (docs/design/base.md#referral-invite-links): the dapp's invite link, for the neuron.
import { getAddress, isAddress, zeroAddress } from 'viem';

/** The `ref` address of a URL's query string, or null (missing, not an address, the zero address). Only the first counts. */
export function referrerOf(search) {
  const ref = new URLSearchParams(search).get('ref');
  return ref && isAddress(ref) && getAddress(ref) !== zeroAddress ? ref : null;
}

/** The link that makes whoever opens it this vault's referral. */
export const inviteLink = (origin, vault) => (origin && vault ? `${origin}/?ref=${vault}` : '');
