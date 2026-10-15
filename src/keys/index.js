// Key management: the one place the secret lives while unlocked.
//
//   const vault = await createVault(entropy, passphrase)  // sealed record (JSON) for the db
//   const id = await unlock(vault, passphrase)            // throws 'Wrong passphrase'
//   id.address, id.pubkey, id.sign(msg), await id.words(passphrase)
//   id.lock()                                             // wipes the secret; sign() then throws
export { generateEntropy, entropyFromWords, deriveKeys, signMessage, verifyMessage } from './keys.js';
import { deriveKeys, signMessage } from './keys.js';
import { seal, unseal } from './seal.js';

export const createVault = (entropy, passphrase, opts) => seal(entropy, passphrase, opts);

export async function unlock(vault, passphrase) {
  let secret = await unseal(vault, passphrase);
  const { address, pubkey } = deriveKeys(secret);
  return {
    address,
    pubkey,
    get locked() { return secret === null; },
    sign(msg) {
      if (!secret) throw new Error('Locked');
      return signMessage(secret, msg);
    },
    /** The 24 words, only after the passphrase is entered again. */
    async words(again) {
      const e = await unseal(vault, again);
      try { return deriveKeys(e).words; } finally { e.fill(0); }
    },
    lock() {
      secret?.fill(0);
      secret = null;
    },
  };
}
