// The wallet's signer, held in one place (src/keyring.js): opened by Unlock, wiped by Lock, a Lock in flight wins.
import { describe, expect, test } from 'vitest';
import { createKeyring } from './keyring.js';

const signer = () => ({ locked: false, lock() { this.locked = true; } });
const sessionWith = (unlock, connected = null) => ({
  unlock, walletPublic: { evmAddress: '0x00000000000000000000000000000000000000aa', connected },
});

describe('the keyring', () => {
  test('Unlock opens the wallet, Lock wipes it; a second Unlock wipes the first signer', async () => {
    const [a, b] = [signer(), signer()];
    const next = [a, b];
    const k = createKeyring({ session: sessionWith(async () => ({ wallet: next.shift(), linked: false, rekeyed: false })) });
    expect(k.wallet).toBe(null);
    expect(await k.unlock('pass')).toEqual({ linked: false, rekeyed: false, opened: true });
    expect(k.wallet).toBe(a);
    await k.unlock('pass');
    expect([k.wallet, a.locked]).toEqual([b, true]);
    k.lock();
    expect([k.wallet, b.locked]).toEqual([null, true]);
  });

  test('a Lock while an Unlock is in flight wins: the signer it opened is wiped, never kept', async () => {
    const v = signer();
    let done;
    const k = createKeyring({ session: sessionWith(() => new Promise((r) => { done = () => r({ wallet: v, linked: true, rekeyed: false }); })) });
    const p = k.unlock('pass', (fn) => fn());
    k.lock();
    done();
    expect(await p).toEqual({ linked: true, rekeyed: false, opened: false });
    expect([k.wallet, v.locked]).toEqual([null, true]);
  });

  test('a connected wallet found again stays through Lock (no secret here); not found, its actions say where it is', async () => {
    const provider = { request: async () => [] };
    const s = sessionWith(null, { rdns: 'io.example', name: 'Example' });
    const k = createKeyring({ session: s, find: async () => [{ rdns: 'io.example', provider }] });
    expect(await k.findConnected()).toEqual({ name: 'Example', found: true, relay: false });
    k.lock();
    expect(k.wallet?.connected).toBeTruthy();
    const gone = createKeyring({ session: s, find: async () => [] });
    await gone.findConnected();
    expect(gone.wallet).toBe(null);
    expect(gone.notHere().message).toBe("Example isn't in this browser: open the app where it is installed.");
    await expect(gone.connectedBackup('alias')).rejects.toThrow("isn't in this browser");
  });
});
