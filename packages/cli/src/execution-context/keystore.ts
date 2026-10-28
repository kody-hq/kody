import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scryptSync,
} from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Entry } from '@napi-rs/keyring'
import { apiTokenFileStorePath } from '../api-token-store.js'
import { keyringService } from '../defaults.js'
import { secretServiceKeyringOptions } from '../store.js'

export const contextKeyPassphraseEnvVar = 'KODY_CONTEXT_KEY_PASSPHRASE'

export type StoredContext = {
	version: 1
	ecid: string
	name: string
	apiUrl: string
	orgSlug: string | null
	publicKeyJwk: { kty: 'OKP'; crv: 'Ed25519'; x: string }
}

type KeyFile = {
	version: 1
	wrap: 'keyring' | 'passphrase'
	salt?: string
	iv: string
	tag: string
	data: string
}

/** Per-API-origin directory next to the CLI's other config files. */
export function contextsDir(apiUrl: string) {
	return join(dirname(apiTokenFileStorePath(apiUrl)), 'contexts')
}

function contextDir(apiUrl: string, ecid: string) {
	if (!/^ec_[A-Za-z0-9_-]+$/.test(ecid)) {
		throw new Error(`Not an execution context id: ${ecid}`)
	}
	return join(contextsDir(apiUrl), ecid)
}

export type WrappingKeySource = {
	kind: 'keyring' | 'passphrase'
	key(salt: Buffer | null): Buffer
	salt?: Buffer
}

/**
 * The private key is encrypted at rest with AES-256-GCM. The wrapping key
 * comes from the OS keyring, or from a passphrase in
 * KODY_CONTEXT_KEY_PASSPHRASE (scrypt). With neither, refuse.
 */
export function resolveWrappingKey(input: {
	ecid: string
	env?: NodeJS.ProcessEnv
	create: boolean
	keyringFactory?: (account: string) => {
		getPassword(): string | null
		setPassword(value: string): void
	}
}): WrappingKeySource {
	const env = input.env ?? process.env
	const passphrase = env[contextKeyPassphraseEnvVar]
	if (passphrase) {
		return {
			kind: 'passphrase',
			key: (salt) =>
				scryptSync(passphrase, salt ?? Buffer.alloc(16), 32, {
					N: 1 << 15,
					r: 8,
					p: 1,
					maxmem: 64 * 1024 * 1024,
				}),
		}
	}
	const account = `execution-context:${input.ecid}`
	let entry: { getPassword(): string | null; setPassword(value: string): void }
	try {
		entry = input.keyringFactory
			? input.keyringFactory(account)
			: new Entry(keyringService, account, secretServiceKeyringOptions)
	} catch {
		throw noWrappingKeyError()
	}
	return {
		kind: 'keyring',
		key: () => {
			let stored: string | null = null
			try {
				stored = entry.getPassword()
			} catch {
				stored = null
			}
			if (stored) return Buffer.from(stored, 'base64url')
			if (!input.create) {
				throw new Error(
					'The key for this execution context is missing from the OS keyring. Re-register the machine with `kody context register`.',
				)
			}
			const fresh = randomBytes(32)
			try {
				entry.setPassword(fresh.toString('base64url'))
			} catch {
				throw noWrappingKeyError()
			}
			return fresh
		},
	}
}

function noWrappingKeyError() {
	return new Error(
		`No OS keyring is available to protect this machine's execution context key. Set ${contextKeyPassphraseEnvVar} to a strong passphrase and retry.`,
	)
}

export function encryptPrivateKey(
	privateJwk: unknown,
	wrapping: WrappingKeySource,
): KeyFile {
	const salt = wrapping.kind === 'passphrase' ? randomBytes(16) : null
	const key = wrapping.key(salt)
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	const data = Buffer.concat([
		cipher.update(JSON.stringify(privateJwk), 'utf8'),
		cipher.final(),
	])
	return {
		version: 1,
		wrap: wrapping.kind,
		...(salt ? { salt: salt.toString('base64url') } : {}),
		iv: iv.toString('base64url'),
		tag: cipher.getAuthTag().toString('base64url'),
		data: data.toString('base64url'),
	}
}

export function decryptPrivateKey(
	file: KeyFile,
	wrapping: WrappingKeySource,
): unknown {
	if (file.wrap !== wrapping.kind) {
		throw new Error(
			file.wrap === 'passphrase'
				? `This context key is protected by a passphrase. Set ${contextKeyPassphraseEnvVar}.`
				: `This context key is protected by the OS keyring. Unset ${contextKeyPassphraseEnvVar}.`,
		)
	}
	const key = wrapping.key(
		file.salt ? Buffer.from(file.salt, 'base64url') : null,
	)
	const decipher = createDecipheriv(
		'aes-256-gcm',
		key,
		Buffer.from(file.iv, 'base64url'),
	)
	decipher.setAuthTag(Buffer.from(file.tag, 'base64url'))
	try {
		const plain = Buffer.concat([
			decipher.update(Buffer.from(file.data, 'base64url')),
			decipher.final(),
		])
		return JSON.parse(plain.toString('utf8'))
	} catch {
		throw new Error(
			'Could not decrypt the execution context key. The passphrase or keyring entry does not match.',
		)
	}
}

export function saveContext(input: {
	context: StoredContext
	privateJwk: unknown
	wrapping: WrappingKeySource
}) {
	const dir = contextDir(input.context.apiUrl, input.context.ecid)
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	const keyPath = join(dir, 'key.enc')
	writeFileSync(
		keyPath,
		JSON.stringify(encryptPrivateKey(input.privateJwk, input.wrapping)),
		{ mode: 0o600 },
	)
	chmodSync(keyPath, 0o600)
	writeFileSync(
		join(dir, 'context.json'),
		`${JSON.stringify(input.context, null, 2)}\n`,
		{ mode: 0o600 },
	)
}

export function loadContext(input: {
	apiUrl: string
	ecid: string
	wrapping: WrappingKeySource
}): { context: StoredContext; privateJwk: unknown } {
	const dir = contextDir(input.apiUrl, input.ecid)
	const context = JSON.parse(
		readFileSync(join(dir, 'context.json'), 'utf8'),
	) as StoredContext
	const file = JSON.parse(readFileSync(join(dir, 'key.enc'), 'utf8')) as KeyFile
	return { context, privateJwk: decryptPrivateKey(file, input.wrapping) }
}
