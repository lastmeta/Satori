// Key derivations, exactly as the Docker neuron (satorilib) does them.
// One 32-byte secp256k1 secret ("entropy") is at once the private key and the
// BIP39 entropy of the 24 words. No HD path, no mnemonicToSeed.
// Design and evidence: docs/design/keys.md
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { ripemd160 } from '@noble/hashes/legacy';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, utf8ToBytes, randomBytes } from '@noble/hashes/utils';
import { createBase58check, base64 } from '@scure/base';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

const b58c = createBase58check(sha256);
const N = secp256k1.CURVE.n;
const ADDRESS_VERSION = 0x21; // Evrmore P2PKH, 'E…'
const WIF_VERSION = 0x80;
const MAGIC = utf8ToBytes('Evrmore Signed Message:\n');

const toBig = (b) => BigInt('0x' + (bytesToHex(b) || '0'));

function checkKey(k) {
  if (!(k instanceof Uint8Array) || k.length !== 32) throw new Error('key must be 32 bytes');
  const n = toBig(k);
  if (n < 1n || n >= N) throw new Error('key out of secp256k1 range');
  return k;
}

/** 32 random bytes with 1 ≤ k < n. */
export function generateEntropy() {
  for (;;) {
    const k = randomBytes(32);
    const n = toBig(k);
    if (n >= 1n && n < N) return k;
  }
}

/** Compressed or uncompressed pubkey bytes → Evrmore P2PKH address. */
function addressFromPubkey(pub) {
  return b58c.encode(concatBytes(Uint8Array.of(ADDRESS_VERSION), ripemd160(sha256(pub))));
}

/** @param {Uint8Array} entropy @returns {{pubkey: string, address: string}} */
export function publicKeys(entropy) {
  const pub = secp256k1.getPublicKey(checkKey(entropy), true);
  return { pubkey: bytesToHex(pub), address: addressFromPubkey(pub) };
}

/** sha256 of the P2PKH script, reversed (the Electrumx scripthash). */
function scripthash(pub) {
  const script = concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), ripemd160(sha256(pub)), Uint8Array.of(0x88, 0xac));
  return bytesToHex(sha256(script).reverse());
}

/** Every field Docker writes to wallet.yaml. Secrets included: build it only to save or show it. */
export function deriveKeys(entropy) {
  const pub = secp256k1.getPublicKey(checkKey(entropy), true);
  return {
    entropy: base64.encode(entropy),
    words: entropyToMnemonic(entropy, wordlist),
    wif: b58c.encode(concatBytes(Uint8Array.of(WIF_VERSION), entropy, Uint8Array.of(1))),
    pubkey: bytesToHex(pub),
    address: addressFromPubkey(pub),
    scripthash: scripthash(pub),
  };
}

/** Compressed mainnet WIF (52 chars) → entropy. */
export function entropyFromWif(wif) {
  const b = b58c.decode(wif.trim());
  if (b.length !== 34 || b[0] !== WIF_VERSION || b[33] !== 1) throw new Error('not a compressed WIF key');
  return checkKey(b.slice(1, 33));
}

/** 24 backup words → entropy. Tolerates case and extra whitespace. */
export function entropyFromWords(words) {
  const norm = words.trim().toLowerCase().split(/\s+/).join(' ');
  const e = mnemonicToEntropy(norm, wordlist);
  if (e.length !== 32) throw new Error('expected 24 words');
  return checkKey(e);
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

/** Evrmore signed message: base64 of [27+recid+4] || r || s (low-S, RFC 6979). */
export function signMessage(entropy, msg) {
  const sig = secp256k1.sign(messageHash(msg), checkKey(entropy), { lowS: true });
  return base64.encode(concatBytes(Uint8Array.of(27 + sig.recovery + 4), sig.toCompactRawBytes()));
}

/**
 * True when `signature` signs `msg` for the given pubkey (hex) or address. The
 * key is recovered in the form the header names (31-34 compressed, 27-30 not),
 * as python-evrmorelib's verifyMessage does.
 */
export function verifyMessage(msg, signature, { pubkey, address } = {}) {
  try {
    const raw = base64.decode(signature);
    if (raw.length !== 65 || raw[0] < 27 || raw[0] > 34) return false;
    const pub = secp256k1.Signature.fromCompact(raw.slice(1))
      .addRecoveryBit((raw[0] - 27) & 3)
      .recoverPublicKey(messageHash(msg))
      .toRawBytes(raw[0] >= 31);
    if (pubkey && bytesToHex(pub) === pubkey.toLowerCase()) return true;
    return !!address && addressFromPubkey(pub) === address;
  } catch {
    return false;
  }
}

/**
 * The Base (EVM) address of a public key (hex, compressed or not), EIP-55
 * checksummed: satorilib's `ethAddress`, `Account.from_key(entropy)` on the
 * same secret (wallet/ethereum/wallet.py:114-121).
 */
export function evmAddress(pubkeyHex) {
  const pub = secp256k1.ProjectivePoint.fromHex(pubkeyHex.toLowerCase()).toRawBytes(false);
  const hex = bytesToHex(keccak_256(pub.slice(1)).slice(-20));
  const sum = bytesToHex(keccak_256(utf8ToBytes(hex)));
  return '0x' + [...hex].map((c, i) => (parseInt(sum[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

/** An ECDSA signature over a 32-byte digest (an EVM transaction hash), as viem's `sign`: RFC 6979, low-S. */
export function signDigest(entropy, digest) {
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new Error('digest must be 32 bytes');
  const { r, s, recovery } = secp256k1.sign(digest, checkKey(entropy), { lowS: true });
  const h32 = (n) => `0x${n.toString(16).padStart(64, '0')}`;
  return { r: h32(r), s: h32(s), yParity: recovery, v: recovery ? 28n : 27n };
}
