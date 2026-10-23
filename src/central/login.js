// Central's login signature (docs/design/central.md#login-signature): EIP-191
// personal_sign of the challenge by the alias, as central's /auth/login
// verifies it (central base-upgrade f4d72f5, src/utils/auth.py
// verify_wallet_signature: it recovers the signer and compares it with the
// Ethereum address of the `wallet-pubkey` header) and as Satori Lite signs it
// (satorilib 5028913). Internal to the central client; never shown.
import { hashMessage, hexToBytes, serializeSignature } from 'viem';
import { signDigest } from '../keys/keys.js';

/**
 * `0x` ‖ r ‖ s ‖ v (130 hex): keccak256("\x19Ethereum Signed Message:\n" + the
 * UTF-8 byte length + the message), signed with RFC 6979 (deterministic), low s, v = 27 or 28.
 */
export const loginSignature = (secret, message) => serializeSignature(signDigest(secret, hexToBytes(hashMessage(message))));
