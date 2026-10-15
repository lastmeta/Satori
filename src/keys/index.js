// Satori's two keys, as Satori Lite keeps them (docs/design/keys.md):
//   identity — wallet.yaml, unencrypted, so the neuron signs on its own;
//   vault    — vault.yaml, fields encrypted with the passphrase, holds funds.
//
//   const { walletYaml, vaultYaml } = await writeKeys({ identity?, vault }, passphrase)  // to store
//   const { walletYaml, vaultYaml } = await importDocker({ walletText, vaultText, passphrase })
//   const id = await loadIdentity(walletYaml)       // id.address, id.pubkey, id.sign(msg), id.backup()
//   vaultInfo(vaultYaml)                            // { address, pubkey } while locked
//   const v = await unlockVault(vaultYaml, pass)    // Unlock; throws 'Wrong passphrase'
//   v.sign(msg), v.backup(), v.lock()               // Lock wipes the key; then both throw 'Locked'
export { generateEntropy, entropyFromWords, entropyFromWif, deriveKeys, signMessage, verifyMessage } from './keys.js';
import { generateEntropy, deriveKeys, publicKeys, signMessage } from './keys.js';
import { readWallet, writeWallet, parse } from './docker.js';

export const MIN_PASSPHRASE = 4; // Docker vault-setup (neuron/web/routes.py:589)

function checkPassphrase(p) {
  if (typeof p !== 'string' || p.length < MIN_PASSPHRASE) throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
}

const sameKey = (x, y) => x.length === y.length && x.every((b, i) => b === y[i]);
const notSame = (x, y) => {
  if (sameKey(x, y)) throw new Error('The identity and the vault must not be the same key.');
};

/** A signer over a 32-byte secret; lock() wipes it. */
function signer(secret) {
  const { address, pubkey } = publicKeys(secret);
  return {
    address,
    pubkey,
    get locked() { return secret === null; },
    sign(msg) {
      if (!secret) throw new Error('Locked');
      return signMessage(secret, msg);
    },
    /** The 24 words and the private key (WIF), for backup. */
    backup() {
      if (!secret) throw new Error('Locked');
      const { words, wif } = deriveKeys(secret);
      return { words, wif };
    },
    lock() {
      secret?.fill(0);
      secret = null;
    },
  };
}

/** New files for a vault (and an identity, random when not given). */
export async function writeKeys({ identity = generateEntropy(), vault }, passphrase) {
  checkPassphrase(passphrase);
  notSame(identity, vault);
  const [walletYaml, vaultYaml] = await Promise.all([writeWallet(identity), writeWallet(vault, { password: passphrase })]);
  return { walletYaml, vaultYaml };
}

/**
 * Docker's two files and the vault's passphrase → files to store. Refuses a
 * wrong passphrase, a watch-only file, and a file whose stored fields don't
 * match its key (Docker: "wallet or vault file corrupt"). The identity is
 * re-written from its key; the vault is kept as given unless its address is
 * encrypted (an old vault), so the address can show while locked.
 */
export async function importDocker({ walletText, vaultText, passphrase }) {
  const read = async (name, text, opts) => {
    try {
      const r = await readWallet(text, opts);
      if (r.mismatches.length) throw new Error(`stored ${r.mismatches.join(', ')} do not match its key`);
      return r;
    } catch (err) {
      throw new Error(`${name}: ${err.message}`);
    }
  };
  const id = await read('wallet.yaml', walletText, { password: passphrase });
  const vault = await read('vault.yaml', vaultText, { password: passphrase });
  notSame(id.entropy, vault.entropy);
  const walletYaml = await writeWallet(id.entropy);
  const vaultYaml = vaultInfo(vaultText).address ? vaultText : await writeWallet(vault.entropy, { password: passphrase });
  return { walletYaml, vaultYaml };
}

/** The identity from its unencrypted wallet.yaml. */
export async function loadIdentity(walletYaml) {
  return signer((await readWallet(walletYaml)).entropy);
}

/** The vault's public fields, read without the passphrase (start.py getVaultInfoFromFile). */
export function vaultInfo(vaultYaml) {
  const doc = parse(vaultYaml);
  const address = doc.evr?.address;
  const ok = typeof address === 'string' && address.length <= 34;
  return { address: ok ? address : null, pubkey: ok && typeof doc.publicKey === 'string' ? doc.publicKey : null };
}

/** Unlock: decrypt the vault into memory. A key that doesn't match the stored address is a wrong passphrase. */
export async function unlockVault(vaultYaml, passphrase) {
  const { entropy, mismatches } = await readWallet(vaultYaml, { password: passphrase });
  if (mismatches.length) {
    entropy.fill(0);
    throw new Error('Wrong passphrase');
  }
  return signer(entropy);
}
