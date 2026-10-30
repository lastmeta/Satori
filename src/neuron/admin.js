// The Satori contract's admin (docs/design/admin.md): SatoriRewards.admin(), and what only it may do, as the dapp's Admin
// tab drives it (contract/satori-ui/src/components/AdminTab.tsx, hooks/useOwner.ts). The emission split and schedule
// default to the admin but are their own keys, with their own pages. Every write is the wallet's.
import { formatEther, getAddress, isAddress, parseEther, zeroAddress } from 'viem';

const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const DEFAULT_GAME = 1; // live by construction: its approval can't be set (SatoriVoting.sol:238)

/** SatoriHub's capability ids (SatoriHub.sol:132-144), each a switch for everyone but the admin. */
export const CAPABILITIES = [
  { bit: 0, name: 'Create streams', text: 'Anyone may create a data stream (and its game).' },
  { bit: 1, name: 'Author games', text: 'Anyone may add a custom game to a stream.' },
  { bit: 2, name: 'Register stream adapters', text: 'Anyone may register a community stream adapter, burning the registration fee.' },
  { bit: 3, name: 'Register game adapters', text: 'Anyone may register a community game adapter, burning the registration fee.' },
  { bit: 4, name: 'Bounties', text: 'Anyone may fund or stake on a bounty.' },
  { bit: 5, name: 'Stake with someone', text: 'Anyone may stake their prediction power with another address.' },
  { bit: 6, name: 'Name a claimer', text: 'Anyone may let another address claim their rewards.' },
  { bit: 7, name: 'Vote', text: 'Anyone may burn SATORI to vote for games.' },
];

/** Whether `me` is the admin: { admin, isAdmin }. An RPC error throws. */
export async function adminRole(chain, me) {
  const [admin] = await chain.roleReads([['rewards', 'admin']]);
  return { admin, isAdmin: same(admin, me) };
}

/**
 * The admin's levers as they stand: { admin, capabilities: [{ bit, name, text, on }], relayer, registrationFee (wei),
 * reporter, games: [{ streamId, gameId, name, approved, isDefault }] } (a stream with no game left out).
 */
export async function adminState(chain) {
  const [admin, relayer, registrationFee, reporter, streams, ...bits] = await chain.roleReads([
    ['rewards', 'admin'], ['rewards', 'officialRelayer'], ['rewards', 'registrationFee'], ['engine', 'offchainReporter'],
    ['registry', 'getAllDataStreams'], ...CAPABILITIES.map((c) => ['rewards', 'capabilityAllowed', [c.bit, zeroAddress]])]);
  const ids = [...streams];
  const per = ids.length ? await chain.roleReads(ids.flatMap((id) => [['registry', 'getDataStreamInfo', [id]], ['games', 'binaryGameByStream', [id]]])) : [];
  const found = ids.map((id, i) => ({ streamId: id, name: per[2 * i][0], gameId: Number(per[2 * i + 1]) })).filter((g) => g.gameId);
  const approved = found.length ? await chain.roleReads(found.map((g) => ['voting', 'gameApproved', [g.gameId]])) : [];
  return {
    admin, relayer, registrationFee, reporter,
    capabilities: CAPABILITIES.map((c, i) => ({ ...c, on: bits[i] })),
    games: found.map((g, i) => ({ ...g, isDefault: g.gameId === DEFAULT_GAME, approved: g.gameId === DEFAULT_GAME || approved[i] })),
  };
}

const addressIn = (to, { empty = false } = {}) => {
  const t = String(to ?? '').trim();
  if (empty && t === '') return zeroAddress;
  if (!isAddress(t)) throw new Error('That is not a valid address.');
  return getAddress(t);
};
const sent = async (chain, key, name, fn, args, { step, opts }, label) => {
  step('send', 1, 1);
  return [{ hash: (await chain.roleWrite(key, name, fn, args, opts(step))).hash, label }];
};

/**
 * The admin's actions (docs/design/admin.md#the-cards), each from `key`; step(name, k, n) says the work, opts(step) a
 * write's options. → [{ hash, label }]. The contracts refuse anyone but the admin; the checks here say why first.
 */
export const adminOps = {
  /** The whole capability policy at once: `on`, the bits switched on (the contract takes the full mask). */
  capabilities: async (chain, key, on, run) => {
    const bits = [...new Set(on.map(Number))];
    if (bits.some((b) => !CAPABILITIES.some((c) => c.bit === b))) throw new Error('That is not one of the capabilities.');
    return sent(chain, key, 'rewards', 'setCapabilities', [bits.reduce((m, b) => m | (1n << BigInt(b)), 0n)], run, 'Saved');
  },
  game: async (chain, key, gameId, approved, run) => {
    if (Number(gameId) === DEFAULT_GAME) throw new Error('The default game is always approved.');
    return sent(chain, key, 'voting', 'setGameApproved', [Number(gameId), !!approved], run, approved ? 'Approved' : 'Disapproved');
  },
  /** The relayer that may be paid out of unclaimed rewards; empty: none. */
  relayer: async (chain, key, to, run) => sent(chain, key, 'rewards', 'setOfficialRelayer', [addressIn(to, { empty: true })], run, 'Set'),
  /** SATORI burned per community adapter registration (a decimal string, above 0). */
  registrationFee: async (chain, key, satori, run) => {
    let wei;
    try { wei = parseEther(String(satori ?? '').trim()); } catch { throw new Error('That is not an amount of SATORI.'); }
    if (!(wei > 0n)) throw new Error('The fee must be above 0.');
    return sent(chain, key, 'rewards', 'setRegistrationFee', [wei], run, 'Set');
  },
  /** Who may add off-chain predictions to the default stream's count; empty: no one (off). */
  reporter: async (chain, key, to, run) => sent(chain, key, 'engine', 'setOffchainReporter', [addressIn(to, { empty: true })], run, 'Set'),
  /** An official adapter: kind 'stream' or 'game', its contract and name. */
  registerAdapter: async (chain, key, kind, impl, name, run) => {
    if (kind !== 'stream' && kind !== 'game') throw new Error("The kind is 'stream' or 'game'.");
    const n = String(name ?? '').trim();
    if (!n) throw new Error('Give the adapter a name.');
    return sent(chain, key, 'hub', kind === 'stream' ? 'registerAdapter' : 'registerGameAdapter', [addressIn(impl), n], run, 'Registered');
  },
  /** Hands the admin to `to` at once (not two-step). */
  transfer: async (chain, key, to, run) => sent(chain, key, 'rewards', 'setAdmin', [addressIn(to)], run, 'Transferred'),
};

/** admin()'s answer: the levers as plain values (SATORI as decimal strings). */
export function adminView(a) {
  if (!a.shown || !a.levers) return { shown: false, admin: a.address || null };
  const l = a.levers;
  return { shown: true, admin: l.admin, capabilities: l.capabilities.map(({ bit, name, on }) => ({ bit, name, on })),
    officialRelayer: l.relayer, registrationFee: formatEther(l.registrationFee), offchainReporter: l.reporter, games: l.games };
}
