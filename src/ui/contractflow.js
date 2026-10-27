// Home's Satori contract card (docs/design/health.md#the-contract-card), pure: what the contract is for, whether a
// prediction went to it this round, and what has to be in place for it to keep happening, each a check with its fix.

/** A prediction went to the contract this round: the app's batch, or the game played by hand. */
export const predictedToday = (b) => b?.round != null && (b.lastBatch?.round === b.round || b.lastPlay?.round === b.round);

/**
 * The checks for the mode the app is in. Each: { id, state: 'ok' | 'bad' | 'wait', text, fix? } (fix: 'stake',
 * 'fund' with its address, 'game'). By hand, the player is the alias when the wallet is staked with it, else the wallet.
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
    if (byAlias) out.push({ id: 'stake', state: 'ok', text: 'Staked with this app: it sends your plays, no passphrase needed.' });
    else if (staked !== 'other') out.push({ id: 'stake', state: 'wait', text: 'Not staked: each play asks for your passphrase. Stake with this app so it sends them for you.', fix: 'stake' });
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

// ── the Network and Relays cards: the same idea for the other two chips ──

const DAY_S = 86400;
const ago = (s) => (s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < DAY_S ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / DAY_S)} d ago`);

/** The Satori Network: predictions went out in the last day (central took some). */
export function networkSent(c, now) {
  const s = c?.lastSubmit;
  return !!s && !s.error && s.successful > 0 && now - s.at < DAY_S;
}

/** The Network card's checks: registered, predictions sent (fix: 'poll'). (A wallet the Satori Network won't pay: Home's card.) */
export function networkChecks(c, now) {
  if (!c) return [];
  const reg = c.registration;
  const s = c.lastSubmit;
  return [
    !reg ? { id: 'register', state: 'wait', text: 'Registering with the Satori Network…' }
      : reg.ok ? { id: 'register', state: 'ok', text: 'Registered with the Satori Network.' }
        : { id: 'register', state: 'bad', text: `Not registered: ${reg.error}.`, fix: 'poll' },
    networkSent(c, now) ? { id: 'sent', state: 'ok', text: `Sent ${s.successful} predictions ${ago(now - s.at)}.` }
      : s?.error ? { id: 'sent', state: 'bad', text: `The last send failed: ${s.error}.`, fix: 'poll' }
        : { id: 'sent', state: 'wait', text: s ? 'Nothing sent in the last day.' : 'The first predictions go out soon.', fix: s ? 'poll' : undefined },
  ];
}

const usable = (n) => (n?.relays ?? []).filter((r) => r.state !== 'blocked');
/** The Satori relays: at least one connected. */
export const relaysOn = (n) => usable(n).some((r) => r.state === 'open');

/** The Relays card's checks: connected, watching prediction streams, publishing (fix: 'streams'). */
export function relayChecks(n) {
  if (!n) return [];
  const all = usable(n);
  const up = all.filter((r) => r.state === 'open').length;
  const watching = n.watching?.streams ?? 0;
  const subs = (n.subscriptions ?? []).filter((x) => x.predict !== false).length;
  return [
    up ? { id: 'connected', state: 'ok', text: `Connected to ${up} of ${all.length} relay${all.length === 1 ? '' : 's'}.` }
      : { id: 'connected', state: all.length ? 'bad' : 'wait', text: all.length ? 'No relay connected right now; it keeps trying.' : 'No relays yet.' },
    watching ? { id: 'watching', state: 'ok', text: `Watching ${watching} prediction stream${watching === 1 ? '' : 's'}, keeping their track records.` }
      : { id: 'watching', state: 'wait', text: 'Looking for prediction streams…' },
    (n.own?.streams ?? 0) ? { id: 'own', state: 'ok', text: `Publishing this app's ${n.own.streams} other stream${n.own.streams === 1 ? '' : 's'}: its Satori Network and Satori contract predictions.` }
      : { id: 'own', state: 'wait', text: "This app's Satori Network and Satori contract predictions are published after its next poll." },
    subs ? { id: 'publishing', state: 'ok', text: `Publishing your predictions for ${subs} stream${subs === 1 ? '' : 's'} you subscribe to.` }
      : { id: 'publishing', state: 'wait', text: 'You can choose streams to predict; their predictions are relayed to the Nostr network.', fix: 'streams' },
  ];
}
