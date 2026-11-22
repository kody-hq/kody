import { Effect } from 'effect'
import { sha256Hex } from './module-hashes.ts'

/** SHA-256 hex of bytes or UTF-8 text. Web Crypto digest does not fail. */
export const digestSha256Hex = (bytes: Uint8Array | ArrayBuffer | string) =>
	// effect-check: allow Web Crypto digest, local and infallible
	Effect.promise(() => sha256Hex(bytes))
