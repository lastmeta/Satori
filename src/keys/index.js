// Key management: the one place the secret lives while unlocked.
//
//   const vault = await createVault(entropy, passphrase)  // sealed record (JSON) for the db
//   const id = await unlock(vault, passphrase)            // throws 'Wrong passphrase'
//   id.address, id.pubkey, id.sign(msg), await id.words(passphrase)  // both throw 'Locked' after lock()
//   id.lock()                                             // wipes the secret; sign() then throws
export { generateEntropy, entropyFromWords, deriveKeys, publicKeys, signMessage, verifyMessage } from './keys.js';
import { deriveKeys, publicKeys, signMessage } from './keys.js';
import { seal, unseal } from './seal.js';

export const createVault = (entropy, passphrase, opts) => seal(entropy, passphrase, opts);

export async function unlock(vault, passphrase) {
  let secret = await unseal(vault, passphrase);
  const { address, pubkey } = publicKeys(secret); // no words: they stay sealed
  return {
    address,
    pubkey,
    get locked() { return secret === null; },
    sign(msg) {
      if (!secret) throw new Error('Locked');
      return signMessage(secret, msg);
    },
    /** The 24 words, only after the passphrase is entered again, and only while unlocked. */
    async words(again) {
      if (!secret) throw new Error('Locked');
      const e = await unseal(vault, again);
      try {
        if (!secret) throw new Error('Locked'); // Lock pressed during the unseal
        return deriveKeys(e).words;
      } finally { e.fill(0); }
    },
    lock() {
      secret?.fill(0);
      secret = null;
    },
  };
}
