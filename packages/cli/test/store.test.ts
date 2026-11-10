import assert from 'node:assert/strict'
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	accountForMcpUrl,
	createFileBackend,
	fileCredentialStoreForced,
	fileStorePath,
	parseCredentials,
	saveCredentials,
	loadCredentials,
	deleteCredentials,
	resolveBackend,
	secretServiceKeyringOptions,
	type SecretBackend,
	type StoredCredentials,
} from '../src/store.js'

const sample: StoredCredentials = {
	version: 1,
	mcpUrl: 'https://kody.codes/mcp',
	resource: 'https://kody.codes/mcp',
	authorizationServerUrl: 'https://kody.codes',
	clientId: 'client-1',
	accessToken: 'access-1',
	refreshToken: 'refresh-1',
	tokenType: 'bearer',
	expiresAt: Date.now() + 60_000,
	scope: 'profile email',
}

function memoryKeyring(initial: string | null = null): SecretBackend & {
	value: string | null
} {
	const store: SecretBackend & { value: string | null } = {
		kind: 'keyring',
		value: initial,
		get() {
			return store.value
		},
		set(value: string) {
			store.value = value
		},
		delete() {
			const had = store.value !== null
			store.value = null
			return had
		},
	}
	return store
}

function tempFilePath(): string {
	return join(mkdtempSync(join(tmpdir(), 'kody-cli-')), 'credentials.json')
}

test('accountForMcpUrl is origin-scoped', () => {
	assert.equal(
		accountForMcpUrl('https://kody.codes/mcp'),
		'cli:https://kody.codes',
	)
	assert.equal(
		accountForMcpUrl('https://preview.kody.codes/mcp'),
		'cli:https://preview.kody.codes',
	)
})

test('fileStorePath uses XDG on linux-like homes', () => {
	const path = fileStorePath('https://kody.codes/mcp', '/tmp/home')
	assert.match(path, /credentials-kody\.codes\.json$/)
})

test('Linux keyring is pinned to Secret Service so keyutils cannot silently win', () => {
	assert.equal(secretServiceKeyringOptions.linux.store, 'secret-service')
})

test('file backend stores, loads, and deletes credentials', () => {
	const dir = mkdtempSync(join(tmpdir(), 'kody-cli-'))
	const backend = createFileBackend(join(dir, 'credentials.json'))
	saveCredentials(sample, backend)
	const loaded = loadCredentials(sample.mcpUrl, backend)
	assert.deepEqual(loaded, sample)
	if (process.platform !== 'win32' && backend.path) {
		chmodSync(backend.path, 0o600)
		assert.equal(statSync(backend.path).mode & 0o777, 0o600)
	}
	assert.equal(deleteCredentials(sample.mcpUrl, backend).deleted, true)
	assert.equal(loadCredentials(sample.mcpUrl, backend), null)
})

test('parseCredentials rejects invalid payloads', () => {
	assert.throws(() => parseCredentials('{}'), /invalid/i)
	assert.throws(() => parseCredentials('{"version":2}'), /invalid/i)
})

test('KODY_CLI_CREDENTIAL_STORE=file skips the OS keyring', () => {
	assert.equal(
		fileCredentialStoreForced({ KODY_CLI_CREDENTIAL_STORE: 'file' }),
		true,
	)
	assert.equal(
		fileCredentialStoreForced({ KODY_CLI_CREDENTIAL_STORE: 'keyring' }),
		false,
	)
	assert.equal(fileCredentialStoreForced({}), false)
	const previous = process.env.KODY_CLI_CREDENTIAL_STORE
	process.env.KODY_CLI_CREDENTIAL_STORE = 'file'
	try {
		const path = tempFilePath()
		const backend = resolveBackend(sample.mcpUrl, undefined, {
			fileStorePath: () => path,
		})
		saveCredentials(sample, backend)
		assert.equal(existsSync(path), true)
		assert.equal(loadCredentials(sample.mcpUrl, backend)?.mcpUrl, sample.mcpUrl)
	} finally {
		if (previous === undefined) delete process.env.KODY_CLI_CREDENTIAL_STORE
		else process.env.KODY_CLI_CREDENTIAL_STORE = previous
	}
})

test('resolveBackend uses the file store when the keyring constructor throws', () => {
	const path = tempFilePath()
	const backend = resolveBackend(sample.mcpUrl, undefined, {
		createKeyring() {
			throw new Error('Secret Service is unavailable')
		},
		fileStorePath: () => path,
	})
	assert.equal(backend.kind, 'file')
	assert.equal(backend.path, path)
})

test('saveCredentials writes the file when Secret Service is unavailable', () => {
	const path = tempFilePath()
	const saved = saveCredentials(sample, undefined, {
		createKeyring() {
			throw new Error('Secret Service is unavailable')
		},
		fileStorePath: () => path,
	})
	assert.equal(saved.backend.kind, 'file')
	assert.equal(saved.backend.path, path)
	assert.equal(existsSync(path), true)
	if (process.platform !== 'win32') {
		assert.equal(statSync(path).mode & 0o777, 0o600)
	}
	assert.deepEqual(loadCredentials(sample.mcpUrl, saved.backend), sample)
})

test('saveCredentials falls back to the file when keyring set throws', () => {
	const path = tempFilePath()
	const keyring: SecretBackend = {
		kind: 'keyring',
		get: () => null,
		set() {
			throw new Error('setPassword failed')
		},
		delete: () => false,
	}
	const saved = saveCredentials(sample, undefined, {
		createKeyring: () => keyring,
		fileStorePath: () => path,
	})
	assert.equal(saved.backend.kind, 'file')
	const written = JSON.parse(readFileSync(path, 'utf8')) as {
		pending?: { accessToken?: string }
		orgs?: Record<string, { accessToken?: string }>
	}
	const token =
		written.pending?.accessToken ??
		Object.values(written.orgs ?? {})[0]?.accessToken
	assert.equal(token, 'access-1')
})

test('loadCredentials falls back to the file when keyring credentials are invalid', () => {
	const path = tempFilePath()
	createFileBackend(path).set(JSON.stringify(sample))
	const loaded = loadCredentials(sample.mcpUrl, undefined, {
		createKeyring: () => memoryKeyring('{"version":1}'),
		fileStorePath: () => path,
	})
	assert.deepEqual(loaded, sample)
})

test('loadCredentials surfaces invalid file credentials after a keyring miss', () => {
	const path = tempFilePath()
	createFileBackend(path).set('{"version":1}')
	assert.throws(
		() =>
			loadCredentials(sample.mcpUrl, undefined, {
				createKeyring: () => memoryKeyring(null),
				fileStorePath: () => path,
			}),
		/invalid/i,
	)
})

test('loadCredentials falls back to the file when the keyring returns null', () => {
	const path = tempFilePath()
	createFileBackend(path).set(JSON.stringify(sample))
	const loaded = loadCredentials(sample.mcpUrl, undefined, {
		createKeyring: () => memoryKeyring(null),
		fileStorePath: () => path,
	})
	assert.deepEqual(loaded, sample)
})

test('loadCredentials prefers keyring credentials over a leftover file', () => {
	const path = tempFilePath()
	createFileBackend(path).set(
		JSON.stringify({ ...sample, accessToken: 'file-access' }),
	)
	const loaded = loadCredentials(sample.mcpUrl, undefined, {
		createKeyring: () =>
			memoryKeyring(
				JSON.stringify({ ...sample, accessToken: 'keyring-access' }),
			),
		fileStorePath: () => path,
	})
	assert.equal(loaded?.accessToken, 'keyring-access')
})

test('loadCredentials does not use the file when a preferred backend returns null', () => {
	const path = tempFilePath()
	createFileBackend(path).set(JSON.stringify(sample))
	const loaded = loadCredentials(sample.mcpUrl, memoryKeyring(null), {
		fileStorePath: () => path,
	})
	assert.equal(loaded, null)
})

test('deleteCredentials removes both keyring and file copies', () => {
	const path = tempFilePath()
	const keyring = memoryKeyring(JSON.stringify(sample))
	createFileBackend(path).set(JSON.stringify(sample))
	const result = deleteCredentials(sample.mcpUrl, undefined, {
		createKeyring: () => keyring,
		fileStorePath: () => path,
	})
	assert.equal(result.deleted, true)
	assert.equal(keyring.value, null)
	assert.equal(existsSync(path), false)
})
