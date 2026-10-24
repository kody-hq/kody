import { utcDayKey } from '@kody-internal/shared/date-keys.ts'

/**
 * The per-package bridge capability a package app wrapper holds in its private
 * module scope. It is written into the wrapper module, so it is part of the
 * hashed module graph behind the stable Dynamic Worker id.
 *
 * A cached app build is keyed per visitor, package, and published commit.
 * Deriving the capability from that key (and the UTC day) with a server-held
 * key keeps the module text, and so the worker id, stable when the build cache
 * expires and the build is recreated. A random value per build would mint a
 * new worker id (another unique worker day and a cold isolate) on every
 * rebuild.
 *
 * Package code never sees the server key, so it cannot compute the capability
 * for any other build. One build's capability is accepted only by the bridge
 * props of that same build (same visitor, package, commit, and day).
 */

const bindingTokenInfo = new TextEncoder().encode(
	'kody-package-app-binding-token-v1',
)

const derivationKeys = new Map<string, Promise<CryptoKey>>()

function derivationKey(secretStoreKey: string) {
	let key = derivationKeys.get(secretStoreKey)
	if (!key) {
		key = (async () => {
			const base = await crypto.subtle.importKey(
				'raw',
				new TextEncoder().encode(secretStoreKey),
				'HKDF',
				false,
				['deriveKey'],
			)
			return await crypto.subtle.deriveKey(
				{
					name: 'HKDF',
					hash: 'SHA-256',
					salt: new Uint8Array(),
					info: bindingTokenInfo,
				},
				base,
				{ name: 'HMAC', hash: 'SHA-256', length: 256 },
				false,
				['sign'],
			)
		})()
		key.catch(() => {
			derivationKeys.delete(secretStoreKey)
		})
		derivationKeys.set(secretStoreKey, key)
	}
	return key
}

function toHex(bytes: Uint8Array) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	)
}

/** 32 random bytes as hex: the capability for a one-off (uncached) build. */
export function createRandomPackageBindingToken() {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return toHex(bytes)
}

/**
 * The capability for a cached build: HMAC-SHA-256 (HKDF-derived from
 * `SECRET_STORE_KEY`) over the build cache key and the UTC day, as 64 hex
 * chars. Falls back to a random capability when no usable server key is
 * bound (local and unit tests), which is safe but not stable.
 */
export async function packageAppBindingTokenFor(input: {
	secretStoreKey: string | undefined
	cacheKey: string
	now?: Date
}) {
	const secretStoreKey = input.secretStoreKey?.trim() ?? ''
	if (secretStoreKey.length < 32) {
		return createRandomPackageBindingToken()
	}
	const day = utcDayKey(input.now ?? new Date(Date.now()))
	const signature = await crypto.subtle.sign(
		'HMAC',
		await derivationKey(secretStoreKey),
		new TextEncoder().encode(
			JSON.stringify(['package-app-binding@v1', day, input.cacheKey]),
		),
	)
	return toHex(new Uint8Array(signature))
}
