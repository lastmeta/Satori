// Who plays the Satori contract's games, the one rule (docs/design/base.md#the-game): the alias when the wallet is
// staked with it (it sends with no passphrase), else the wallet itself.
/** `staked`: base().wallet.staked ('alias' | 'none' | 'other' | null) → 'alias' | 'wallet' */
export const playerOf = (staked) => (staked === 'alias' ? 'alias' : 'wallet');
/**
 * Whom the daily reminder watches on the chain (docs/design/push.md): whoever sends today's predictions. Automatic: the
 * alias (the daily batch); by hand: the player.
 */
export const sendsToday = ({ play, staked }) => (play === 'manual' ? playerOf(staked) : 'alias');
