import { Entry } from '@napi-rs/keyring'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultApiUrl, keyringService } from './defaults.js'
import {
	createFileBackend,
	secretServiceKeyringOptions,
	type SecretBackend,
	type StoreResolution,
} from './store.js'

/**
 * Scoped API token stored by `auth bootstrap` (ADR 0056) for
 * `execute --local`, Open API search/whoami, and token-auth cloud execute.
 * Separate from `kody login` OAuth credentials.
 */
export type StoredApiToken = {
	version: 1
	apiUrl: string
	token: string
	tokenId: string
	name?: string
	scopes?: Array<string>
	expiresAt?: string | null
	maxExpiresAt?: string | null
	createdVia?: string
}

function accountForApiUrl(apiUrl: string): string {
	return `cli-api-token:${new URL(apiUrl).origin}`
}

export function apiTokenFileStorePath(
	apiUrl: string,
	home: string = homedir(),
): string {
	const origin = new URL(apiUrl).host.replace(/[^a-zA-Z0-9.-]/g, '_')
	const base =
		process.platform === 'win32'
			? join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'kody')
			: process.platform === 'darwin'
				? join(home, 'Library', 'Application Support', 'kody')
				: join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'kody')
	return join(base, `api-token-${origin}.json`)
}

function createApiTokenKeyringBackend(apiUrl: string): SecretBackend {
	const entry = new Entry(
		keyringService,
		accountForApiUrl(apiUrl),
		secretServiceKeyringOptions,
	)
	return {
		kind: 'keyring',
		get() {
			try {
				return entry.getPassword()
			} catch {
				return null
			}
		},
		set(value: string) {
			entry.setPassword(value)
		},
		delete() {
			try {
				return entry.deleteCredential()
			} catch {
				return false
			}
		},
	}
}

function fileBackendFor(
	apiUrl: string,
	resolution?: StoreResolution,
): SecretBackend {
	const path =
		resolution?.fileStorePath?.(apiUrl) ?? apiTokenFileStorePath(apiUrl)
	return createFileBackend(path)
}

function resolveApiTokenBackend(
	apiUrl: string,
	preferred?: SecretBackend,
	resolution?: StoreResolution,
): SecretBackend {
	if (preferred) return preferred
	try {
		return (resolution?.createKeyring ?? createApiTokenKeyringBackend)(apiUrl)
	} catch {
		return fileBackendFor(apiUrl, resolution)
	}
}

export function parseStoredApiToken(raw: string): StoredApiToken {
	const parsed = JSON.parse(raw) as StoredApiToken
	if (
		parsed.version !== 1 ||
		typeof parsed.token !== 'string' ||
		!parsed.token.startsWith('kody_at_') ||
		typeof parsed.apiUrl !== 'string' ||
		typeof parsed.tokenId !== 'string'
	) {
		throw new Error(
			'Stored Kody API token is invalid. Run `kody auth bootstrap --code …` again.',
		)
	}
	return parsed
}

function readParsed(store: SecretBackend): StoredApiToken | null {
	const raw = store.get()
	if (!raw) return null
	return parseStoredApiToken(raw)
}

export function loadStoredApiToken(
	apiUrl: string = defaultApiUrl,
	backend?: SecretBackend,
	resolution?: StoreResolution,
): StoredApiToken | null {
	const store = resolveApiTokenBackend(apiUrl, backend, resolution)
	try {
		const loaded = readParsed(store)
		if (loaded) return loaded
	} catch (error) {
		if (!(store.kind === 'keyring' && !backend)) throw error
	}
	if (store.kind === 'keyring' && !backend) {
		return readParsed(fileBackendFor(apiUrl, resolution))
	}
	return null
}

export function saveStoredApiToken(
	credentials: StoredApiToken,
	backend?: SecretBackend,
	resolution?: StoreResolution,
): { backend: SecretBackend } {
	const store = resolveApiTokenBackend(credentials.apiUrl, backend, resolution)
	try {
		store.set(JSON.stringify(credentials))
		return { backend: store }
	} catch (error) {
		if (store.kind === 'keyring' && !backend) {
			const fallback = fileBackendFor(credentials.apiUrl, resolution)
			fallback.set(JSON.stringify(credentials))
			return { backend: fallback }
		}
		throw error
	}
}

export function deleteStoredApiToken(
	apiUrl: string = defaultApiUrl,
	backend?: SecretBackend,
	resolution?: StoreResolution,
): { deleted: boolean; backend: SecretBackend } {
	const store = resolveApiTokenBackend(apiUrl, backend, resolution)
	let deleted = false
	try {
		deleted = store.delete()
	} catch {
		deleted = false
	}
	if (store.kind === 'keyring' && !backend) {
		const file = fileBackendFor(apiUrl, resolution)
		deleted = file.delete() || deleted
	}
	return { deleted, backend: store }
}
