// Who plays the Satori contract's games, the one rule (docs/design/base.md#the-game): the alias when the wallet is
// staked with it (it sends with no passphrase), else the wallet itself.
/** `staked`: base().wallet.staked ('alias' | 'none' | 'other' | null) → 'alias' | 'wallet' */
export const playerOf = (staked) => (staked === 'alias' ? 'alias' : 'wallet');
/**
 * Whom the daily reminder watches on the chain (docs/design/push.md): whoever sends today's predictions. Automatic: the
 * alias (the daily batch); by hand: the player.
 */
export const sendsToday = ({ play, staked }) => (play === 'manual' ? playerOf(staked) : 'alias');

/**
 * The next step to earning more on the contract (Home's nudge, the owner 2026-10-27): the first thing missing for the
 * app to predict there by itself each day, in the order they can be done: 'eth' (Base ETH in the wallet: Preload gas
 * and Stake spend it), 'gas' (gas preloaded to this app's address: Stake needs it there first, then each day's batch),
 * 'stake' (staked with this app), 'auto' (Automatic, not by hand). null: nothing missing, or nothing to earn with yet
 * (under 1 SATORI).
 */
export function nextStep(b) {
  if (!b?.config || b.play == null || Number(b.wallet?.satori ?? 0) < 1) return null;
  const staked = b.wallet?.staked === 'alias';
  const gas = staked ? !(b.alias?.noGas || b.alias?.lowEth) : !b.alias?.noGas; // before staking: enough for Stake's own
  if ((!staked || !gas) && (b.wallet?.lowEth || !(Number(b.wallet?.eth) > 0))) return 'eth';
  if (!gas) return 'gas';
  if (!staked) return 'stake';
  return b.play === 'manual' ? 'auto' : null;
}
