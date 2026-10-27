import {
	chmodSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { Entry } from '@napi-rs/keyring'
import { defaultMcpUrl, keyringService } from './defaults.js'

/**
 * Per-org OAuth credentials used by login / MCP / local-execute Bearer.
 * `org` is the bound organization slug (ADR 0064). Legacy single-org payloads
 * may omit it until silent migration discovers the slug via metaGetCurrentUser.
 */
export type StoredCredentials = {
	version: 1
	mcpUrl: string
	/** Organization slug this grant is bound to. */
	org?: string
	resource: string
	authorizationServerUrl: string
	clientId: string
	clientSecret?: string
	accessToken: string
	refreshToken?: string
	tokenType: string
	expiresAt?: number
	scope?: string
}

/** On-disk / keychain envelope for one or more org logins (same MCP origin). */
export type MultiOrgCredentialStore = {
	version: 2
	mcpUrl: string
	/** Active org slug; null while a legacy v1 session awaits slug discovery. */
	activeOrg: string | null
	/** Org slug → credentials (without version/mcpUrl envelope fields). */
	orgs: Record<string, OrgCredentialRecord>
	/**
	 * Legacy single-org tokens waiting for an org slug. At most one. Cleared
	 * once metaGetCurrentUser (or login --org) promotes them into `orgs`.
	 */
	pending?: OrgCredentialRecord
}

export type OrgCredentialRecord = {
	org?: string
	resource: string
	authorizationServerUrl: string
	clientId: string
	clientSecret?: string
	accessToken: string
	refreshToken?: string
	tokenType: string
	expiresAt?: number
	scope?: string
}

export type SecretBackend = {
	kind: 'keyring' | 'file'
	path?: string
	get(): string | null
	set(value: string): void
	delete(): boolean
}

/** Linux-only: require Secret Service. Ignored on macOS and Windows. */
export const secretServiceKeyringOptions = {
	linux: { store: 'secret-service' },
} as const

export type StoreResolution = {
	createKeyring?: (mcpUrl: string) => SecretBackend
	fileStorePath?: (mcpUrl: string) => string
}

export function accountForMcpUrl(mcpUrl: string): string {
	return `cli:${new URL(mcpUrl).origin}`
}

export function fileStorePath(
	mcpUrl: string,
	home: string = homedir(),
): string {
	const origin = new URL(mcpUrl).host.replace(/[^a-zA-Z0-9.-]/g, '_')
	const base =
		process.platform === 'win32'
			? join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'kody')
			: process.platform === 'darwin'
				? join(home, 'Library', 'Application Support', 'kody')
				: join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'kody')
	return join(base, `credentials-${origin}.json`)
}

export function createFileBackend(path: string): SecretBackend {
	return {
		kind: 'file',
		path,
		get() {
			try {
				return readFileSync(path, 'utf8')
			} catch {
				return null
			}
		},
		set(value: string) {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
			writeFileSync(path, value, { mode: 0o600 })
			try {
				chmodSync(path, 0o600)
			} catch {
				// Windows cannot apply POSIX modes.
			}
		},
		delete() {
			try {
				unlinkSync(path)
				return true
			} catch {
				return false
			}
		},
	}
}

export function createKeyringBackend(mcpUrl: string): SecretBackend {
	const entry = new Entry(
		keyringService,
		accountForMcpUrl(mcpUrl),
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
	mcpUrl: string,
	resolution?: StoreResolution,
): SecretBackend {
	const path = resolution?.fileStorePath?.(mcpUrl) ?? fileStorePath(mcpUrl)
	return createFileBackend(path)
}

export function resolveBackend(
	mcpUrl: string,
	preferred?: SecretBackend,
	resolution?: StoreResolution,
): SecretBackend {
	if (preferred) return preferred
	try {
		return (resolution?.createKeyring ?? createKeyringBackend)(mcpUrl)
	} catch {
		return fileBackendFor(mcpUrl, resolution)
	}
}

function withDerivedIssuer(parsed: StoredCredentials): StoredCredentials {
	// Pre-SEP-2352 / partial payloads may omit authorizationServerUrl. Derive
	// the issuer stamp from the MCP origin so reload does not warn, and the
	// next successful save/refresh persists the real AS issuer.
	if (
		typeof parsed.authorizationServerUrl === 'string' &&
		parsed.authorizationServerUrl.trim()
	) {
		return parsed
	}
	if (typeof parsed.mcpUrl !== 'string' || !parsed.mcpUrl) {
		throw new Error('Stored Kody credentials are invalid. Run `kody login`.')
	}
	return {
		...parsed,
		authorizationServerUrl: new URL(parsed.mcpUrl).origin,
	}
}

function recordToCredentials(
	mcpUrl: string,
	record: OrgCredentialRecord,
	org?: string,
): StoredCredentials {
	const slug = org ?? record.org
	return withDerivedIssuer({
		version: 1,
		mcpUrl,
		...(slug ? { org: slug } : {}),
		resource: record.resource,
		authorizationServerUrl: record.authorizationServerUrl,
		clientId: record.clientId,
		...(record.clientSecret !== undefined
			? { clientSecret: record.clientSecret }
			: {}),
		accessToken: record.accessToken,
		...(record.refreshToken !== undefined
			? { refreshToken: record.refreshToken }
			: {}),
		tokenType: record.tokenType,
		...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
		...(record.scope !== undefined ? { scope: record.scope } : {}),
	})
}

function credentialsToRecord(
	credentials: StoredCredentials,
): OrgCredentialRecord {
	return {
		...(credentials.org ? { org: credentials.org } : {}),
		resource: credentials.resource,
		authorizationServerUrl: credentials.authorizationServerUrl,
		clientId: credentials.clientId,
		...(credentials.clientSecret !== undefined
			? { clientSecret: credentials.clientSecret }
			: {}),
		accessToken: credentials.accessToken,
		...(credentials.refreshToken !== undefined
			? { refreshToken: credentials.refreshToken }
			: {}),
		tokenType: credentials.tokenType,
		...(credentials.expiresAt !== undefined
			? { expiresAt: credentials.expiresAt }
			: {}),
		...(credentials.scope !== undefined ? { scope: credentials.scope } : {}),
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseOrgRecord(value: unknown): OrgCredentialRecord | null {
	if (!isRecord(value)) return null
	if (typeof value.accessToken !== 'string' || !value.accessToken) return null
	if (typeof value.clientId !== 'string' || !value.clientId) return null
	if (typeof value.resource !== 'string' || !value.resource) return null
	if (typeof value.tokenType !== 'string' || !value.tokenType) return null
	const authorizationServerUrl =
		typeof value.authorizationServerUrl === 'string'
			? value.authorizationServerUrl
			: ''
	return {
		...(typeof value.org === 'string' && value.org.trim()
			? { org: value.org.trim().toLowerCase() }
			: {}),
		resource: value.resource,
		authorizationServerUrl,
		clientId: value.clientId,
		...(typeof value.clientSecret === 'string'
			? { clientSecret: value.clientSecret }
			: {}),
		accessToken: value.accessToken,
		...(typeof value.refreshToken === 'string'
			? { refreshToken: value.refreshToken }
			: {}),
		tokenType: value.tokenType,
		...(typeof value.expiresAt === 'number'
			? { expiresAt: value.expiresAt }
			: {}),
		...(typeof value.scope === 'string' ? { scope: value.scope } : {}),
	}
}

/** Parse v1 single-org or v2 multi-org JSON from the credential backend. */
export function parseCredentialStore(
	raw: string,
	fallbackMcpUrl: string = defaultMcpUrl,
): MultiOrgCredentialStore {
	const parsed: unknown = JSON.parse(raw)
	if (!isRecord(parsed) || typeof parsed.version !== 'number') {
		throw new Error('Stored Kody credentials are invalid. Run `kody login`.')
	}
	if (parsed.version === 2) {
		const mcpUrl =
			typeof parsed.mcpUrl === 'string' && parsed.mcpUrl
				? parsed.mcpUrl
				: fallbackMcpUrl
		const orgs: Record<string, OrgCredentialRecord> = {}
		if (isRecord(parsed.orgs)) {
			for (const [key, value] of Object.entries(parsed.orgs)) {
				const record = parseOrgRecord(value)
				if (!record) {
					throw new Error(
						'Stored Kody credentials are invalid. Run `kody login`.',
					)
				}
				const slug = (record.org ?? key).trim().toLowerCase()
				if (!slug) {
					throw new Error(
						'Stored Kody credentials are invalid. Run `kody login`.',
					)
				}
				orgs[slug] = { ...record, org: slug }
			}
		}
		const pending =
			parsed.pending !== undefined ? parseOrgRecord(parsed.pending) : undefined
		if (parsed.pending !== undefined && !pending) {
			throw new Error('Stored Kody credentials are invalid. Run `kody login`.')
		}
		const activeOrgRaw =
			typeof parsed.activeOrg === 'string'
				? parsed.activeOrg.trim().toLowerCase()
				: null
		const activeOrg =
			activeOrgRaw && orgs[activeOrgRaw]
				? activeOrgRaw
				: (Object.keys(orgs).sort((a, b) => a.localeCompare(b))[0] ?? null)
		return {
			version: 2,
			mcpUrl,
			activeOrg,
			orgs,
			...(pending ? { pending } : {}),
		}
	}
	if (parsed.version === 1) {
		const credentials = parseCredentials(JSON.stringify(parsed))
		return migrateV1ToMultiOrg(credentials)
	}
	throw new Error('Stored Kody credentials are invalid. Run `kody login`.')
}

/**
 * Silent offline migration: wrap a v1 single-org payload as a multi-org store.
 * When `org` is already known, it becomes the active org; otherwise tokens sit
 * in `pending` until metaGetCurrentUser (or login) supplies the slug.
 */
export function migrateV1ToMultiOrg(
	credentials: StoredCredentials,
): MultiOrgCredentialStore {
	const record = credentialsToRecord(withDerivedIssuer(credentials))
	const slug =
		typeof credentials.org === 'string' && credentials.org.trim()
			? credentials.org.trim().toLowerCase()
			: null
	if (slug) {
		return {
			version: 2,
			mcpUrl: credentials.mcpUrl,
			activeOrg: slug,
			orgs: { [slug]: { ...record, org: slug } },
		}
	}
	return {
		version: 2,
		mcpUrl: credentials.mcpUrl,
		activeOrg: null,
		orgs: {},
		pending: record,
	}
}

/** @deprecated Prefer parseCredentialStore; kept for tests and callers that expect v1. */
export function parseCredentials(raw: string): StoredCredentials {
	const parsed = JSON.parse(raw) as StoredCredentials
	if (parsed.version !== 1 || !parsed.accessToken || !parsed.clientId) {
		throw new Error('Stored Kody credentials are invalid. Run `kody login`.')
	}
	const withOrg =
		typeof parsed.org === 'string' && parsed.org.trim()
			? { ...parsed, org: parsed.org.trim().toLowerCase() }
			: parsed
	return withDerivedIssuer(withOrg)
}

function readStore(
	store: SecretBackend,
	mcpUrl: string,
): MultiOrgCredentialStore | null {
	const raw = store.get()
	if (!raw) return null
	return parseCredentialStore(raw, mcpUrl)
}

function writeStore(
	store: SecretBackend,
	snapshot: MultiOrgCredentialStore,
): void {
	store.set(JSON.stringify(snapshot))
}

function emptyStore(mcpUrl: string): MultiOrgCredentialStore {
	return { version: 2, mcpUrl, activeOrg: null, orgs: {} }
}

export function loadCredentialStore(
	mcpUrl: string = defaultMcpUrl,
	backend?: SecretBackend,
	resolution?: StoreResolution,
): MultiOrgCredentialStore | null {
	const store = resolveBackend(mcpUrl, backend, resolution)
	try {
		const loaded = readStore(store, mcpUrl)
		if (loaded) return loaded
	} catch (error) {
		if (!(store.kind === 'keyring' && !backend)) throw error
	}
	if (store.kind === 'keyring' && !backend) {
		return readStore(fileBackendFor(mcpUrl, resolution), mcpUrl)
	}
	return null
}

export function saveCredentialStore(
	snapshot: MultiOrgCredentialStore,
	backend?: SecretBackend,
	resolution?: StoreResolution,
): { backend: SecretBackend } {
	const store = resolveBackend(snapshot.mcpUrl, backend, resolution)
	try {
		writeStore(store, snapshot)
		return { backend: store }
	} catch (error) {
		if (store.kind === 'keyring' && !backend) {
			const fallback = fileBackendFor(snapshot.mcpUrl, resolution)
			writeStore(fallback, snapshot)
			return { backend: fallback }
		}
		throw error
	}
}

/**
 * Resolve one org's credentials. Precedence for which org: explicit `org`
 * option, else the store's active org, else the sole pending legacy session.
 */
export function loadCredentials(
	mcpUrl: string = defaultMcpUrl,
	backend?: SecretBackend,
	resolution?: StoreResolution,
	options?: { org?: string },
): StoredCredentials | null {
	const snapshot = loadCredentialStore(mcpUrl, backend, resolution)
	if (!snapshot) return null
	return pickCredentialsFromStore(snapshot, options?.org)
}

/** Legacy pending session only (not the active named org). */
export function loadPendingCredentials(
	mcpUrl: string = defaultMcpUrl,
	backend?: SecretBackend,
	resolution?: StoreResolution,
): StoredCredentials | null {
	const snapshot = loadCredentialStore(mcpUrl, backend, resolution)
	if (!snapshot?.pending) return null
	return recordToCredentials(snapshot.mcpUrl, snapshot.pending)
}

export function pickCredentialsFromStore(
	snapshot: MultiOrgCredentialStore,
	org?: string,
): StoredCredentials | null {
	const requested = org?.trim().toLowerCase()
	if (requested) {
		const record = snapshot.orgs[requested]
		if (record) return recordToCredentials(snapshot.mcpUrl, record, requested)
		// Pending-only legacy store: keep commands working when discovery has
		// not named the session yet, but do NOT attach the requested slug —
		// that would let a refresh persist an unverified org name.
		if (snapshot.pending && Object.keys(snapshot.orgs).length === 0) {
			return recordToCredentials(snapshot.mcpUrl, snapshot.pending)
		}
		return null
	}
	if (snapshot.activeOrg && snapshot.orgs[snapshot.activeOrg]) {
		return recordToCredentials(
			snapshot.mcpUrl,
			snapshot.orgs[snapshot.activeOrg],
			snapshot.activeOrg,
		)
	}
	if (snapshot.pending) {
		return recordToCredentials(snapshot.mcpUrl, snapshot.pending)
	}
	const only = Object.keys(snapshot.orgs)
	if (only.length === 1) {
		const slug = only[0]!
		return recordToCredentials(snapshot.mcpUrl, snapshot.orgs[slug]!, slug)
	}
	return null
}

/**
 * Upsert one org's credentials. Replaces that org's prior tokens when the slug
 * already exists; leaves other orgs untouched.
 *
 * `activate` (default true) makes the saved org active — used by `kody login`.
 * Pass `activate: false` for token refresh so a one-shot `--org` / `KODY_ORG`
 * refresh does not steal the active org from `kody org use`.
 */
export function saveCredentials(
	credentials: StoredCredentials,
	backend?: SecretBackend,
	resolution?: StoreResolution,
	options?: { activate?: boolean },
): { backend: SecretBackend } {
	const mcpUrl = credentials.mcpUrl
	const existing =
		loadCredentialStore(mcpUrl, backend, resolution) ?? emptyStore(mcpUrl)
	const slug =
		typeof credentials.org === 'string' && credentials.org.trim()
			? credentials.org.trim().toLowerCase()
			: null
	const record = credentialsToRecord({
		...credentials,
		...(slug ? { org: slug } : {}),
		authorizationServerUrl:
			withDerivedIssuer(credentials).authorizationServerUrl,
	})
	const activate = options?.activate !== false

	let next: MultiOrgCredentialStore
	if (slug) {
		const currentActive =
			typeof existing.activeOrg === 'string' &&
			existing.activeOrg.length > 0 &&
			existing.orgs[existing.activeOrg]
				? existing.activeOrg
				: null
		next = {
			version: 2,
			mcpUrl,
			activeOrg: activate || !currentActive ? slug : currentActive,
			orgs: {
				...existing.orgs,
				[slug]: { ...record, org: slug },
			},
			// Keep an unresolved legacy session unless this save is promoting it
			// (pending tokens matched / were the only login being named).
			...(existing.pending &&
			existing.pending.accessToken !== record.accessToken
				? { pending: existing.pending }
				: {}),
		}
	} else {
		next = {
			version: 2,
			mcpUrl,
			activeOrg: existing.activeOrg,
			orgs: existing.orgs,
			pending: record,
		}
	}
	return saveCredentialStore(next, backend, resolution)
}

/**
 * Promote pending legacy tokens into `orgs[slug]`.
 * Never overwrites an existing named login (a fresh `kody login` wins), and
 * never steals `activeOrg` away from an already-active named org.
 */
export function promotePendingOrg(
	mcpUrl: string,
	org: string,
	backend?: SecretBackend,
	resolution?: StoreResolution,
): MultiOrgCredentialStore | null {
	const snapshot = loadCredentialStore(mcpUrl, backend, resolution)
	if (!snapshot?.pending) return snapshot
	const slug = org.trim().toLowerCase()
	if (!slug) {
		throw new Error(
			'Organization slug is required to finish credential migration.',
		)
	}
	const existingNamed = snapshot.orgs[slug]
	const orgs = existingNamed
		? snapshot.orgs
		: {
				...snapshot.orgs,
				[slug]: { ...snapshot.pending, org: slug },
			}
	const activeIsNamed =
		typeof snapshot.activeOrg === 'string' &&
		snapshot.activeOrg.length > 0 &&
		snapshot.orgs[snapshot.activeOrg] != null
	const next: MultiOrgCredentialStore = {
		version: 2,
		mcpUrl: snapshot.mcpUrl,
		activeOrg: activeIsNamed ? snapshot.activeOrg : slug,
		orgs,
	}
	saveCredentialStore(next, backend, resolution)
	return next
}

export function setActiveOrg(
	mcpUrl: string,
	org: string,
	backend?: SecretBackend,
	resolution?: StoreResolution,
): MultiOrgCredentialStore {
	const snapshot = loadCredentialStore(mcpUrl, backend, resolution)
	if (!snapshot) {
		throw new Error('Not logged in. Run `kody login`.')
	}
	const slug = org.trim().toLowerCase()
	if (!snapshot.orgs[slug]) {
		const known = listOrgSlugs(snapshot)
		throw new Error(
			known.length > 0
				? `No login stored for org "${slug}". Logged-in orgs: ${known.join(', ')}. Run \`kody login --org ${slug}\`.`
				: `No login stored for org "${slug}". Run \`kody login --org ${slug}\`.`,
		)
	}
	const next: MultiOrgCredentialStore = {
		...snapshot,
		activeOrg: slug,
	}
	saveCredentialStore(next, backend, resolution)
	return next
}

export function listOrgSlugs(snapshot: MultiOrgCredentialStore): Array<string> {
	return Object.keys(snapshot.orgs).sort((a, b) => a.localeCompare(b))
}

export type ListedOrg = {
	slug: string
	active: boolean
	/** True when this row is the unresolved legacy session (no slug yet). */
	pending?: boolean
}

/** Local-only listing for help / `org list` (no network). */
export function listStoredOrgs(
	mcpUrl: string = defaultMcpUrl,
	backend?: SecretBackend,
	resolution?: StoreResolution,
): Array<ListedOrg> {
	const snapshot = loadCredentialStore(mcpUrl, backend, resolution)
	if (!snapshot) return []
	const rows: Array<ListedOrg> = listOrgSlugs(snapshot).map((slug) => ({
		slug,
		active: snapshot.activeOrg === slug,
	}))
	if (snapshot.pending && rows.length === 0) {
		rows.push({ slug: '(pending)', active: true, pending: true })
	}
	return rows
}

export function deleteCredentials(
	mcpUrl: string = defaultMcpUrl,
	backend?: SecretBackend,
	resolution?: StoreResolution,
	options?: { org?: string },
): { deleted: boolean; backend: SecretBackend; remaining: number } {
	const store = resolveBackend(mcpUrl, backend, resolution)
	const snapshot = (() => {
		try {
			return readStore(store, mcpUrl)
		} catch {
			return null
		}
	})()

	if (!options?.org) {
		// Plain logout: remove the active org only (or pending / entire store
		// when that is all that remains). Documented in help.
		if (!snapshot) {
			if (store.kind === 'keyring' && !backend) {
				const file = fileBackendFor(mcpUrl, resolution)
				const fileSnap = readStore(file, mcpUrl)
				if (!fileSnap) return { deleted: false, backend: store, remaining: 0 }
				return deleteCredentials(mcpUrl, file, resolution, options)
			}
			return { deleted: false, backend: store, remaining: 0 }
		}
		const target =
			snapshot.activeOrg ??
			(snapshot.pending ? null : (listOrgSlugs(snapshot)[0] ?? null))
		if (target) {
			return deleteOrgFromStore(snapshot, target, store, backend, resolution)
		}
		if (snapshot.pending) {
			const next: MultiOrgCredentialStore = {
				version: 2,
				mcpUrl: snapshot.mcpUrl,
				activeOrg: snapshot.activeOrg,
				orgs: snapshot.orgs,
			}
			if (Object.keys(next.orgs).length === 0) {
				return wipeStore(mcpUrl, store, backend, resolution)
			}
			writeStore(store, next)
			return {
				deleted: true,
				backend: store,
				remaining: Object.keys(next.orgs).length,
			}
		}
		return wipeStore(mcpUrl, store, backend, resolution)
	}

	const slug = options.org.trim().toLowerCase()
	if (!snapshot) {
		if (store.kind === 'keyring' && !backend) {
			const file = fileBackendFor(mcpUrl, resolution)
			const fileSnap = readStore(file, mcpUrl)
			if (!fileSnap) return { deleted: false, backend: store, remaining: 0 }
			return deleteCredentials(mcpUrl, file, resolution, options)
		}
		return { deleted: false, backend: store, remaining: 0 }
	}
	return deleteOrgFromStore(snapshot, slug, store, backend, resolution)
}

function deleteOrgFromStore(
	snapshot: MultiOrgCredentialStore,
	slug: string,
	store: SecretBackend,
	backend: SecretBackend | undefined,
	resolution: StoreResolution | undefined,
): { deleted: boolean; backend: SecretBackend; remaining: number } {
	if (!snapshot.orgs[slug]) {
		return {
			deleted: false,
			backend: store,
			remaining: Object.keys(snapshot.orgs).length + (snapshot.pending ? 1 : 0),
		}
	}
	const { [slug]: _removed, ...rest } = snapshot.orgs
	const remainingSlugs = Object.keys(rest)
	if (remainingSlugs.length === 0 && !snapshot.pending) {
		return wipeStore(snapshot.mcpUrl, store, backend, resolution)
	}
	const nextActive =
		snapshot.activeOrg === slug
			? (remainingSlugs.sort((a, b) => a.localeCompare(b))[0] ?? null)
			: snapshot.activeOrg
	const next: MultiOrgCredentialStore = {
		version: 2,
		mcpUrl: snapshot.mcpUrl,
		activeOrg: nextActive,
		orgs: rest,
		...(snapshot.pending ? { pending: snapshot.pending } : {}),
	}
	try {
		writeStore(store, next)
		return { deleted: true, backend: store, remaining: remainingSlugs.length }
	} catch (error) {
		if (store.kind === 'keyring' && !backend) {
			const fallback = fileBackendFor(snapshot.mcpUrl, resolution)
			writeStore(fallback, next)
			// Drop the stale keyring secret so the next load prefers the file
			// (loadCredentials prefers keyring over file when both exist).
			try {
				store.delete()
			} catch {
				// best-effort; file has the reduced store either way
			}
			return {
				deleted: true,
				backend: fallback,
				remaining: remainingSlugs.length,
			}
		}
		throw error
	}
}

function wipeStore(
	mcpUrl: string,
	store: SecretBackend,
	backend: SecretBackend | undefined,
	resolution: StoreResolution | undefined,
): { deleted: boolean; backend: SecretBackend; remaining: number } {
	let deleted = false
	try {
		deleted = store.delete()
	} catch {
		deleted = false
	}
	if (store.kind === 'keyring' && !backend) {
		const file = fileBackendFor(mcpUrl, resolution)
		deleted = file.delete() || deleted
	}
	return { deleted, backend: store, remaining: 0 }
}
