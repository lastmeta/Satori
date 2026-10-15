// Key derivations, exactly as the Docker neuron (satorilib) does them.
// One 32-byte secp256k1 secret ("entropy") is at once the Evrmore key, the
// EVM/Base key and the BIP39 entropy of the 24 words. No HD, no mnemonicToSeed.
// Design: docs/design/identity.md
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { ripemd160 } from '@noble/hashes/legacy';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes, randomBytes } from '@noble/hashes/utils';
import { createBase58check, base64 } from '@scure/base';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { privateKeyToAccount } from 'viem/accounts';

const b58c = createBase58check(sha256);
const N = secp256k1.CURVE.n;
const ADDRESS_VERSION = 0x21; // Evrmore P2PKH, 'E…'
const WIF_VERSION = 0x80;
const MAGIC = utf8ToBytes('Evrmore Signed Message:\n');

const toBig = (b) => BigInt('0x' + (bytesToHex(b) || '0'));

/** @param {Uint8Array} k */
function checkKey(k) {
  if (!(k instanceof Uint8Array) || k.length !== 32) throw new Error('key must be 32 bytes');
  const n = toBig(k);
  if (n < 1n || n >= N) throw new Error('key out of secp256k1 range');
  return k;
}

/** 32 random bytes with 1 ≤ k < n (satorilib wallet/identity.py generateEntropy). */
export function generateEntropy() {
  for (;;) {
    const k = randomBytes(32);
    const n = toBig(k);
    if (n >= 1n && n < N) return k;
  }
}

/** Compressed pubkey → Evrmore P2PKH address. */
export function addressFromPubkey(pub) {
  const h160 = ripemd160(sha256(typeof pub === 'string' ? hexToBytes(pub) : pub));
  return b58c.encode(concatBytes(Uint8Array.of(ADDRESS_VERSION), h160));
}

function scripthash(h160) {
  const script = concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), h160, Uint8Array.of(0x88, 0xac));
  return bytesToHex(sha256(script).reverse());
}

/**
 * Everything Docker writes to wallet.yaml, plus the Base address.
 * @param {Uint8Array} entropy
 */
export function deriveKeys(entropy) {
  checkKey(entropy);
  const pub = secp256k1.getPublicKey(entropy, true);
  const h160 = ripemd160(sha256(pub));
  return {
    entropy: base64.encode(entropy),
    words: entropyToMnemonic(entropy, wordlist),
    wif: b58c.encode(concatBytes(Uint8Array.of(WIF_VERSION), entropy, Uint8Array.of(1))),
    pubkey: bytesToHex(pub),
    address: b58c.encode(concatBytes(Uint8Array.of(ADDRESS_VERSION), h160)),
    scripthash: scripthash(h160),
    ethAddress: evmAccount(entropy).address,
  };
}

/** viem local account for Base (satorilib Account.from_key(entropy)). */
export function evmAccount(entropy) {
  return privateKeyToAccount(`0x${bytesToHex(checkKey(entropy))}`);
}

/** 24 backup words → entropy (mnemonicToEntropy; never mnemonicToSeed). */
export function entropyFromWords(words) {
  const norm = words.trim().toLowerCase().split(/\s+/).join(' ');
  const e = mnemonicToEntropy(norm, wordlist);
  if (e.length !== 32) throw new Error('expected 24 words');
  return checkKey(e);
}

/** Compressed mainnet WIF (52 chars) → entropy. */
export function entropyFromWif(wif) {
  const b = b58c.decode(wif.trim());
  if (b.length !== 34 || b[0] !== WIF_VERSION || b[33] !== 1) throw new Error('not a compressed WIF key');
  return checkKey(b.slice(1, 33));
}

function varint(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24);
}

function messageHash(msg) {
  const m = utf8ToBytes(msg);
  return sha256(sha256(concatBytes(varint(MAGIC.length), MAGIC, varint(m.length), m)));
}

/** Evrmore signed message, base64 of [27+recid+4] || r || s (low-S, RFC 6979). */
export function signMessage(entropy, msg) {
  const sig = secp256k1.sign(messageHash(msg), checkKey(entropy), { lowS: true });
  return base64.encode(concatBytes(Uint8Array.of(27 + sig.recovery + 4), sig.toCompactRawBytes()));
}

/**
 * Verifies against a pubkey (hex) or an address, as satorilib's verifyMessage.
 * @param {string} msg @param {string} signature base64
 * @param {{pubkey?: string, address?: string}} who
 */
export function verifyMessage(msg, signature, { pubkey, address } = {}) {
  try {
    const raw = base64.decode(signature);
    if (raw.length !== 65 || raw[0] < 27 || raw[0] > 34) return false;
    const pub = secp256k1.Signature.fromCompact(raw.slice(1))
      .addRecoveryBit((raw[0] - 27) & 3)
      .recoverPublicKey(messageHash(msg));
    const compressed = raw[0] >= 31;
    if (pubkey && pub.toHex(true) === pubkey.toLowerCase()) return true;
    return !!address && addressFromPubkey(pub.toRawBytes(compressed)) === address;
  } catch {
    return false;
  }
}

/** Random Nostr secret (independent of the wallets), 64 hex. */
export function generateNostrSecret() {
  return bytesToHex(generateEntropy());
}

/** Nostr x-only pubkey for a secret, as nostr_sdk Keys. */
export function nostrKeys(secretHex) {
  const s = checkKey(hexToBytes(secretHex.toLowerCase()));
  return { secretHex: bytesToHex(s), pubkeyHex: bytesToHex(schnorr.getPublicKey(s)) };
}
