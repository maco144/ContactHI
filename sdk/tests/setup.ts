/**
 * Jest global test setup.
 *
 * @noble/ed25519 v2 requires a synchronous SHA-512 implementation to be
 * registered when running outside a browser (where SubtleCrypto is unavailable
 * or synchronous hashing is needed). We shim it here using Node.js's built-in
 * crypto module.
 */

import { createHash } from 'crypto'
import * as ed from '@noble/ed25519'

// Register synchronous SHA-512 so getPublicKey (sync) works in tests.
// The async variants (getPublicKeyAsync, signAsync, verifyAsync) use the
// Web Crypto API when available, or fall back to this shim.
(ed as unknown as { etc: { sha512Sync?: (...msgs: Uint8Array[]) => Uint8Array } }).etc.sha512Sync =
  (...msgs: Uint8Array[]): Uint8Array => {
    const h = createHash('sha512')
    for (const msg of msgs) h.update(msg)
    return new Uint8Array(h.digest())
  }
