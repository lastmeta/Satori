// A key is one 32-byte secp256k1 secret: at once the private key and the BIP39
// entropy of its 24 words, with no HD path (satorilib's scheme, kept so a
// migrating neuron's words give the same keys and Base addresses; whether new
// neurons should use BIP32 paths is docs/inbox/QUESTIONS.md). Its Base (EVM)
// address and transaction signatures. Design: docs/design/keys.md
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes, randomBytes } from '@noble/hashes/utils';
import { createBase58check } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

const N = secp256k1.CURVE.n;
const STANDARD_PATH = "m/44'/60'/0'/0/0"; // MetaMask's first account
const toBig = (b) => BigInt('0x' + (bytesToHex(b) || '0'));

/** A valid secret (32 bytes, 1 ≤ k < n), or a throw. */
export function checkKey(k) {
  if (!(k instanceof Uint8Array) || k.length !== 32) throw new Error('key must be 32 bytes');
  const n = toBig(k);
  if (n < 1n || n >= N) throw new Error('key out of secp256k1 range');
  return k;
}

/** 32 random bytes with 1 ≤ k < n. */
export function generateSecret() {
  for (;;) {
    const k = randomBytes(32);
    const n = toBig(k);
    if (n >= 1n && n < N) return k;
  }
}

/** The 24 words of a secret (BIP39 English, the secret as the entropy). */
export const wordsOf = (secret) => entropyToMnemonic(checkKey(secret), wordlist);

/** 24 words → the secret. Tolerates case and extra whitespace. */
export function secretFromWords(words) {
  const norm = String(words).trim().toLowerCase().split(/\s+/).join(' ');
  const e = mnemonicToEntropy(norm, wordlist);
  if (e.length !== 32) throw new Error('expected 24 words');
  return checkKey(e);
}

/** What Import takes: 24 words (the secret itself), 12 words (a standard wallet's, secretFrom12), or the private key (64 hex, 0x optional, as a Base wallet exports it; or a WIF). → the secret */
export function secretFromText(text) {
  const t = String(text).trim();
  const h = /^(0x)?([0-9a-fA-F]{64})$/.exec(t);
  if (h) return checkKey(Uint8Array.from(h[2].match(/../g), (b) => parseInt(b, 16)));
  if (WIF.test(t)) return secretFromWif(t);
  const words = t.toLowerCase().split(/\s+/);
  return words.length === 12 ? secretFrom12(words.join(' ')) : secretFromWords(t);
}

/** 12 words are too few to be a secret: the first account a standard wallet opens from them. */
function secretFrom12(words) {
  if (!validateMnemonic(words, wordlist)) throw new Error('Not valid BIP39 words.');
  const seed = mnemonicToSeedSync(words);
  try {
    return checkKey(HDKey.fromMasterSeed(seed).derive(STANDARD_PATH).privateKey);
  } finally {
    seed.fill(0);
  }
}

/** A WIF (52 characters, K or L; 51, 5): the same 32 bytes in base58check, as a Dockerized Neuron's files give them. */
const WIF = /^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/;
const wif = createBase58check(sha256);
function secretFromWif(text) {
  const b = wif.decode(text); // throws on a bad checksum
  if (b[0] !== 0x80 || !(b.length === 33 || (b.length === 34 && b[33] === 1))) throw new Error('Not a private key.');
  return checkKey(b.slice(1, 33));
}

/** The compressed public key, hex (66). */
export const publicKey = (secret) => bytesToHex(secp256k1.getPublicKey(checkKey(secret), true));

/** The private key as a Base wallet imports it: 0x and 64 hex. */
export const privateKeyHex = (secret) => `0x${bytesToHex(checkKey(secret))}`;

/**
 * The Base (EVM) address of a public key (hex, compressed or not), EIP-55
 * checksummed: satorilib's `ethAddress`, `Account.from_key(entropy)` on the
 * same secret (wallet/ethereum/wallet.py:114-121).
 */
export function evmAddress(pubkeyHex) {
  const pub = secp256k1.ProjectivePoint.fromHex(String(pubkeyHex).toLowerCase()).toRawBytes(false);
  const hex = bytesToHex(keccak_256(pub.slice(1)).slice(-20));
  const sum = bytesToHex(keccak_256(utf8ToBytes(hex)));
  return '0x' + [...hex].map((c, i) => (parseInt(sum[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

/** An ECDSA signature over a 32-byte digest (an EVM transaction hash), as viem's `sign`: RFC 6979, low-S. */
export function signDigest(secret, digest) {
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new Error('digest must be 32 bytes');
  const { r, s, recovery } = secp256k1.sign(digest, checkKey(secret), { lowS: true });
  const h32 = (n) => `0x${n.toString(16).padStart(64, '0')}`;
  return { r: h32(r), s: h32(s), yParity: recovery, v: recovery ? 28n : 27n };
}
