// Home's Satori contract card (docs/design/health.md#the-contract-card), pure: what the contract is for, whether a
// prediction went to it this round, and what has to be in place for it to keep happening, each a check with its fix.

/** A prediction went to the contract this round: the app's batch, or the game played by hand. */
export const predictedToday = (b) => b?.round != null && (b.lastBatch?.round === b.round || b.lastPlay?.round === b.round);

/**
 * The checks for the mode the app is in. Each: { id, state: 'ok' | 'bad' | 'wait', text, fix? } (fix: 'stake',
 * 'fund' with its address, 'game'). by hand, the player is the alias when the wallet is staked with it, else the wallet.
 */
export function contractChecks(b) {
  if (!b?.config || b.play == null) return [];
  const staked = b.wallet?.staked;
  const today = predictedToday(b);
  const fund = (who, address) => ({ fix: 'fund', address, who });
  // first, in both modes: SATORI to take part with (the owner's words)
  const satori = { id: 'satori', state: Number(b.wallet?.satori ?? 0) >= 1 ? 'ok' : 'bad', text: 'Must have at least 1 SATORI in your wallet to participate' };
  if (b.play === 'manual') {
    const byAlias = staked === 'alias';
    const out = [satori];
    if (staked === 'other') out.push({ id: 'free', state: 'bad', text: "Your wallet is staked with another address, so it can't play here. Unstake it on the Wallet tab." });
    const noGas = byAlias ? b.alias?.noGas : b.wallet?.lowEth;
    out.push(noGas
      ? { id: 'gas', state: 'bad', text: `${byAlias ? "This app's address" : 'Your wallet'} needs a little Base ETH to send predictions.`,
        ...fund(byAlias ? 'alias' : 'wallet', byAlias ? b.alias?.address : b.wallet?.address) }
      : { id: 'gas', state: 'ok', text: 'Enough Base ETH to send predictions.' });
    out.push(today ? { id: 'today', state: 'ok', text: 'Played today.' } : { id: 'today', state: 'wait', text: "Today's game isn't played yet.", fix: 'game' });
    return out;
  }
  const out = [satori];
  if (staked === 'alias') out.push({ id: 'stake', state: 'ok', text: 'Staked with this app: it predicts with your SATORI.' });
  else if (staked === 'other') out.push({ id: 'stake', state: 'bad', text: 'Your wallet is staked with another address. Unstake it on the Wallet tab, then stake with this app.' });
  else out.push({ id: 'stake', state: 'bad', text: 'Not staked: stake with this app so it can predict for you.', fix: 'stake' });
  const days = b.alias?.batchesLeft;
  out.push(b.alias?.noGas || b.alias?.lowEth
    ? { id: 'gas', state: 'bad', text: `This app's address needs a little Base ETH for its daily predictions${days ? ` (about ${days} day${days === 1 ? '' : 's'} left)` : ''}.`, ...fund('alias', b.alias?.address) }
    : { id: 'gas', state: 'ok', text: `Enough Base ETH${days ? ` for about ${days >= 1000 ? '1,000+' : days} days` : ''}.` });
  out.push(today ? { id: 'today', state: 'ok', text: 'Predicted today.' }
    : { id: 'today', state: 'wait', text: staked === 'alias' ? "Today's predictions go out at the next check." : 'Nothing predicted today.' });
  return out;
}
