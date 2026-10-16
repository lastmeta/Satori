// Central's protocol crypto, internal to the central client and never shown
// (docs/design/central.md#login-signature):
// - the login signature: central's /auth/login verifies only an Evrmore signed
//   message (auth.py, satorilib's evrmore `verify`), so the identity signs the
//   challenge in that format;
// - the address central keys a peer's wallet and vault by (satorilib's
//   `generateAddress`, P2PKH version 0x21), to compare register's answer
//   with our vault.
// docs/issues/central-login-eip191.md proposes EIP-191 instead, so neurons need neither.
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { ripemd160 } from '@noble/hashes/legacy';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { createBase58check, base64 } from '@scure/base';

const b58c = createBase58check(sha256);
const MAGIC = utf8ToBytes('Evrmore Signed Message:\n');

function varint(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24);
}

function messageHash(msg) {
  const m = utf8ToBytes(msg);
  return sha256(sha256(concatBytes(varint(MAGIC.length), MAGIC, varint(m.length), m)));
}

const addressOf = (pub) => b58c.encode(concatBytes(Uint8Array.of(0x21), ripemd160(sha256(pub))));

/** The address central keeps for a public key (hex): its peer id form, never shown. */
export const centralAddress = (pubkeyHex) => addressOf(secp256k1.ProjectivePoint.fromHex(pubkeyHex).toRawBytes(true));

/** The login signature of `msg`: base64 of [27 + recid + 4] ‖ r ‖ s (compressed key, low-S, RFC 6979). */
export function loginSignature(secret, msg) {
  const sig = secp256k1.sign(messageHash(msg), secret, { lowS: true });
  return base64.encode(concatBytes(Uint8Array.of(27 + sig.recovery + 4), sig.toCompactRawBytes()));
}

/**
 * True when `signature` signs `msg` for the given pubkey (hex) or central
 * address, as central checks it: the key is recovered in the form the header
 * names (31-34 compressed, 27-30 not), as python-evrmorelib's verifyMessage.
 * Tests and the e2e's stub central use it.
 */
export function verifyLoginSignature(msg, signature, { pubkey, address } = {}) {
  try {
    const raw = base64.decode(signature);
    if (raw.length !== 65 || raw[0] < 27 || raw[0] > 34) return false;
    const pub = secp256k1.Signature.fromCompact(raw.slice(1))
      .addRecoveryBit((raw[0] - 27) & 3)
      .recoverPublicKey(messageHash(msg))
      .toRawBytes(raw[0] >= 31);
    if (pubkey && bytesToHex(pub) === pubkey.toLowerCase()) return true;
    return !!address && addressOf(pub) === address;
  } catch {
    return false;
  }
}
