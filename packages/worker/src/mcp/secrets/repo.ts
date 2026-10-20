import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import { earliestSecretExpiresAt } from '@kody-internal/shared/secret-expires-at.ts'
import { credentialGrantCleanupStatements } from '#worker/credentials/credential-grant-cleanup.ts'
import {
	type CredentialFillPlacement,
	defaultNewCredentialFillPlacement,
	serializeCredentialFillPlacement,
} from '#worker/credentials/fill-placement.ts'
import {
	isCredentialPlacementOrigin,
	type CredentialPlacementOrigin,
} from '#worker/credentials/placement-origin.ts'
import {
	disconnectedSecretEncryptedValue,
	isDisconnectedSecretEncryptedValue,
} from '#mcp/secrets/disconnected.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	type SecretBucketRow,
	type SecretEntryRow,
	type SecretScope,
	type StoredCredentialKind,
	storedCredentialKinds,
} from './types.ts'

/** Headers-only default written on classic Key insert (not on conflict update). */
const newCredentialPlacementJson = serializeCredentialFillPlacement(
	defaultNewCredentialFillPlacement,
)!

const listPackageScopeSecretFixedBindings = 2

const secretEntryColumns =
	'id, bucket_id, name, description, encrypted_value, allowed_hosts, allowed_packages, expires_at, created_at, updated_at, placement_json, placement_origin'

type SecretMetadataRow = {
	id: string
	scope: SecretScope
	binding_key: string
	name: string
	description: string
	allowed_hosts: string
	allowed_packages: string
	created_at: string
	updated_at: string
	expires_at: string | null
	/** Null means anywhere. */
	placement_json: string | null
	placement_origin: CredentialPlacementOrigin | null
	/** True when Disconnect cleared the value; row and placement remain. */
	disconnected: boolean
}

type SecretEntryLookup = SecretEntryRow & {
	kind: StoredCredentialKind
	/** Null means anywhere. */
	placement_json: string | null
	placement_origin: CredentialPlacementOrigin | null
}

/**
 * Concurrent identical bucket lookups (fetch-gateway resolving N secrets via
 * Promise.allSettled) share one D1 round-trip (KODY-9K). Cleared when the
 * promise settles so a later write in the same isolate still re-reads.
 */
const inflightSecretBuckets = new WeakMap<
	D1Database,
	Map<string, Promise<SecretBucketRow | null>>
>()

type PendingSecretEntryRequest = {
	bucketId: string
	name: string
	resolve: (entry: SecretEntryLookup | null) => void
	reject: (error: unknown) => void
}

/**
 * Concurrent `getSecretEntry` calls against the same `APP_DB` in one isolate
 * turn share one batched `IN (…)` read per bucket (KODY-9K), matching the
 * entity_sources microtask batch used for KODY-7H. A lone lookup still uses
 * the single-name query.
 */
const pendingSecretEntryBatches = new WeakMap<
	D1Database,
	Array<PendingSecretEntryRequest>
>()

export async function getSecretBucket(input: {
	db: D1Database
	userId: string
	scope: SecretScope
	bindingKey: string
	now?: string
}): Promise<SecretBucketRow | null> {
	// Capture each caller's effective `now` before sharing the D1 load so a
	// later caller that crosses an expiry boundary does not inherit a
	// pre-expiry row from the first coalesced request (KODY-9K follow-up).
	const now = input.now ?? new Date().toISOString()
	const cacheKey = `${input.userId}\0${input.scope}\0${input.bindingKey}`
	let inflight = inflightSecretBuckets.get(input.db)
	if (!inflight) {
		inflight = new Map()
		inflightSecretBuckets.set(input.db, inflight)
	}
	const existing = inflight.get(cacheKey)
	const pending =
		existing ??
		loadSecretBucket({ ...input, now }).finally(() => {
			if (inflight.get(cacheKey) === pending) inflight.delete(cacheKey)
		})
	if (!existing) inflight.set(cacheKey, pending)
	const bucket = await pending
	if (bucket && bucket.expires_at != null && bucket.expires_at <= now) {
		return null
	}
	return bucket
}

async function loadSecretBucket(input: {
	db: D1Database
	userId: string
	scope: SecretScope
	bindingKey: string
	now?: string
}): Promise<SecretBucketRow | null> {
	const now = input.now ?? new Date().toISOString()
	const row = await input.db
		.prepare(
			`SELECT id, user_id, scope, binding_key, expires_at, created_at, updated_at
			FROM secret_buckets
			WHERE user_id = ? AND scope = ? AND binding_key = ?
				AND (expires_at IS NULL OR expires_at > ?)
			${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(input.userId, input.scope, input.bindingKey, now)
		.first<Record<string, unknown>>()
	return row ? mapSecretBucketRow(row) : null
}

export async function upsertSecretBucket(input: {
	db: D1Database
	row: Omit<SecretBucketRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	}
}): Promise<void> {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`INSERT INTO secret_buckets (
				id, user_id, scope, binding_key, expires_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, scope, binding_key)
			DO UPDATE SET
				expires_at = excluded.expires_at,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.row.id,
			input.row.user_id,
			input.row.scope,
			input.row.binding_key,
			input.row.expires_at,
			input.row.created_at ?? now,
			input.row.updated_at ?? now,
		)
		.run()
}

export async function getSecretEntry(input: {
	db: D1Database
	bucketId: string
	name: string
}): Promise<SecretEntryLookup | null> {
	const db = input.db
	return await new Promise<SecretEntryLookup | null>((resolve, reject) => {
		const pending = pendingSecretEntryBatches.get(db)
		if (pending) {
			pending.push({
				bucketId: input.bucketId,
				name: input.name,
				resolve,
				reject,
			})
			return
		}
		pendingSecretEntryBatches.set(db, [
			{
				bucketId: input.bucketId,
				name: input.name,
				resolve,
				reject,
			},
		])
		queueMicrotask(() => {
			void flushSecretEntryBatch(db)
		})
	})
}

async function loadSecretEntry(input: {
	db: D1Database
	bucketId: string
	name: string
}): Promise<SecretEntryLookup | null> {
	const row = await input.db
		.prepare(
			`SELECT ${secretEntryColumns}, kind FROM secret_entries
			WHERE bucket_id = ? AND name = ?
			${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(input.bucketId, input.name)
		.first<Record<string, unknown>>()
	return mapSecretEntryLookup(row)
}

function mapSecretEntryLookup(
	row: Record<string, unknown> | null,
): SecretEntryLookup | null {
	if (!row) return null
	return {
		...mapSecretEntryRow(row),
		kind: readStoredCredentialKind(row['kind']),
		placement_json:
			row['placement_json'] == null ? null : String(row['placement_json']),
		placement_origin: readPlacementOrigin(row['placement_origin']),
	}
}

async function flushSecretEntryBatch(db: D1Database) {
	const pending = pendingSecretEntryBatches.get(db)
	pendingSecretEntryBatches.delete(db)
	if (!pending || pending.length === 0) return

	const byBucket = new Map<string, Array<PendingSecretEntryRequest>>()
	for (const request of pending) {
		const group = byBucket.get(request.bucketId)
		if (group) group.push(request)
		else byBucket.set(request.bucketId, [request])
	}

	await Promise.all(
		[...byBucket.entries()].map(async ([bucketId, requests]) => {
			try {
				const uniqueNames = [
					...new Set(requests.map((request) => request.name)),
				]
				const [singleName] = uniqueNames
				if (uniqueNames.length === 1 && singleName) {
					const entry = await loadSecretEntry({
						db,
						bucketId,
						name: singleName,
					})
					for (const request of requests) request.resolve(entry)
					return
				}
				const byName = await loadSecretEntriesByNames({
					db,
					bucketId,
					names: uniqueNames,
				})
				for (const request of requests) {
					request.resolve(byName.get(request.name) ?? null)
				}
			} catch (error) {
				// Isolate failures per bucket so one D1 error does not reject
				// unrelated secrets that share the same microtask flush.
				for (const request of requests) request.reject(error)
			}
		}),
	)
}

/**
 * Fresh D1 read of live secret entries for `names` in one bucket. Chunks to
 * stay within D1's bound-parameter cap (one binding for bucket id).
 */
async function loadSecretEntriesByNames(input: {
	db: D1Database
	bucketId: string
	names: ReadonlyArray<string>
}): Promise<Map<string, SecretEntryLookup>> {
	const byName = new Map<string, SecretEntryLookup>()
	if (input.names.length === 0) return byName
	const nameChunks = chunkArray([...input.names], maxD1BoundParameters - 1)
	for (const names of nameChunks) {
		const placeholders = names.map(() => '?').join(', ')
		const { results } = await input.db
			.prepare(
				`SELECT ${secretEntryColumns}, kind FROM secret_entries
				WHERE bucket_id = ? AND name IN (${placeholders})
				${andLiveDeletedAtSql()}`,
			)
			.bind(input.bucketId, ...names)
			.all<Record<string, unknown>>()
		for (const row of results ?? []) {
			const entry = mapSecretEntryLookup(row)
			if (entry) byName.set(entry.name, entry)
		}
	}
	return byName
}

export function readStoredCredentialKind(value: unknown): StoredCredentialKind {
	const kind = storedCredentialKinds.find((candidate) => candidate === value)
	if (!kind) throw new Error(`Unknown stored credential kind: ${String(value)}`)
	return kind
}

export type StoredCredentialRow = {
	id: string
	name: string
	kind: StoredCredentialKind
	encrypted_value: string
	allowed_hosts: string
	inject_json: string
	config_json: string | null
	/** Null means anywhere. */
	placement_json: string | null
}

/**
 * A live, unexpired credential entry of `ownerId` by credential id, with the
 * fields a later-kind resolver reads. Includes user-scope Keys and
 * package-bound Keys (which can fill that package's declared needs). Session
 * secrets are never credentials of a kind.
 */
export async function getStoredCredentialEntry(input: {
	db: D1Database
	ownerId: string
	credentialId: string
	now?: string
}): Promise<StoredCredentialRow | null> {
	const now = input.now ?? new Date().toISOString()
	const row = await input.db
		.prepare(
			`SELECT e.id AS id, e.name AS name, e.kind AS kind,
				e.encrypted_value AS encrypted_value, e.allowed_hosts AS allowed_hosts,
				e.inject_json AS inject_json, e.config_json AS config_json,
				e.placement_json AS placement_json
			FROM secret_entries e
			JOIN secret_buckets b ON b.id = e.bucket_id
			WHERE b.user_id = ? AND e.id = ?
				AND (
					(b.scope = 'user' AND b.binding_key = '')
					OR b.scope = 'package'
				)
				AND e.deleted_at IS NULL AND b.deleted_at IS NULL
				AND (e.expires_at IS NULL OR e.expires_at > ?)
				AND (b.expires_at IS NULL OR b.expires_at > ?)
			LIMIT 1`,
		)
		.bind(input.ownerId, input.credentialId, now, now)
		.first<Record<string, unknown>>()
	if (!row) return null
	return {
		id: String(row['id']),
		name: String(row['name']),
		kind: readStoredCredentialKind(row['kind']),
		encrypted_value: String(row['encrypted_value']),
		allowed_hosts: String(row['allowed_hosts']),
		inject_json: String(row['inject_json']),
		config_json: row['config_json'] == null ? null : String(row['config_json']),
		placement_json:
			row['placement_json'] == null ? null : String(row['placement_json']),
	}
}

function prepareUpsertSecretEntryStatement(input: {
	db: D1Database
	row: Omit<SecretEntryRow, 'id' | 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	}
	/**
	 * Set only on insert; conflict updates leave the existing placement.
	 * Null means anywhere (preserve on scope move). Non-null JSON is the
	 * headers-only default for brand-new Keys.
	 */
	newCredentialPlacementJson: string | null
	/** Set only on insert with placement; conflict leaves existing origin. */
	newCredentialPlacementOrigin?: CredentialPlacementOrigin | null
}): D1PreparedStatement {
	const now = new Date().toISOString()
	return input.db
		.prepare(
			`INSERT INTO secret_entries (
				bucket_id, name, description, encrypted_value, allowed_hosts, allowed_packages,
				expires_at, created_at, updated_at, placement_json, placement_origin
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(bucket_id, name)
			DO UPDATE SET
				description = excluded.description,
				encrypted_value = excluded.encrypted_value,
				allowed_hosts = excluded.allowed_hosts,
				allowed_packages = excluded.allowed_packages,
				expires_at = excluded.expires_at,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.row.bucket_id,
			input.row.name,
			input.row.description,
			input.row.encrypted_value,
			input.row.allowed_hosts,
			input.row.allowed_packages,
			input.row.expires_at,
			input.row.created_at ?? now,
			input.row.updated_at ?? now,
			input.newCredentialPlacementJson,
			input.newCredentialPlacementOrigin ?? null,
		)
}

export type SecretEntryCredentialColumns = {
	/** Used only when the upsert inserts; an existing row keeps its id. */
	id: string
	kind: StoredCredentialKind
	config_json: string | null
	provider: string | null
	inject_json: string
	/** Null means anywhere. Omitted on conflict keeps the existing column. */
	placement_json: string | null
}

/**
 * The upsert for a value saved together with its opt-in credential fields
 * (ADR 0068), so the value and where it may go change in one statement.
 */
export function prepareUpsertCredentialSecretEntryStatement(input: {
	db: D1Database
	row: Omit<SecretEntryRow, 'id' | 'created_at' | 'updated_at'> & {
		created_at: string
		updated_at: string
	}
	credential: SecretEntryCredentialColumns
}): D1PreparedStatement {
	return input.db
		.prepare(
			`INSERT INTO secret_entries (
				id, bucket_id, name, description, encrypted_value, allowed_hosts, allowed_packages,
				expires_at, created_at, updated_at, kind, config_json, provider, inject_json,
				placement_json, placement_origin
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(bucket_id, name)
			DO UPDATE SET
				description = excluded.description,
				encrypted_value = excluded.encrypted_value,
				allowed_hosts = excluded.allowed_hosts,
				allowed_packages = excluded.allowed_packages,
				expires_at = excluded.expires_at,
				updated_at = excluded.updated_at,
				kind = excluded.kind,
				config_json = excluded.config_json,
				provider = excluded.provider,
				inject_json = excluded.inject_json,
				placement_json = excluded.placement_json,
				placement_origin = excluded.placement_origin`,
		)
		.bind(
			input.credential.id,
			input.row.bucket_id,
			input.row.name,
			input.row.description,
			input.row.encrypted_value,
			input.row.allowed_hosts,
			input.row.allowed_packages,
			input.row.expires_at,
			input.row.created_at,
			input.row.updated_at,
			input.credential.kind,
			input.credential.config_json,
			input.credential.provider,
			input.credential.inject_json,
			input.credential.placement_json,
			'explicit',
		)
}

export async function upsertSecretEntry(input: {
	db: D1Database
	row: Omit<SecretEntryRow, 'id' | 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	}
	/**
	 * Placement written only on INSERT. Omitted → headers-only default for
	 * brand-new credentials. Explicit `null` keeps anywhere when copying an
	 * existing row into a new bucket (scope / package move).
	 */
	placementOnInsert?: CredentialFillPlacement | null
	placementOriginOnInsert?: CredentialPlacementOrigin | null
}): Promise<void> {
	await prepareUpsertSecretEntryStatement({
		db: input.db,
		row: input.row,
		newCredentialPlacementJson:
			'placementOnInsert' in input
				? serializeCredentialFillPlacement(input.placementOnInsert ?? null)
				: newCredentialPlacementJson,
		newCredentialPlacementOrigin:
			'placementOriginOnInsert' in input
				? (input.placementOriginOnInsert ?? null)
				: null,
	}).run()
}

/**
 * Persist multiple secret entry upserts in one D1 batch so a worker eviction
 * cannot leave a partial write. Statement order is preserved (callers that
 * rotate OAuth refresh tokens must put the refresh-token write first).
 */
export async function upsertSecretEntriesAtomically(input: {
	db: D1Database
	rows: Array<
		Omit<SecretEntryRow, 'id' | 'created_at' | 'updated_at'> & {
			created_at?: string
			updated_at?: string
			/**
			 * Placement written only on INSERT for this row. Omitted →
			 * headers-only default. Explicit `null` preserves anywhere.
			 */
			placementOnInsert?: CredentialFillPlacement | null
			placementOriginOnInsert?: CredentialPlacementOrigin | null
		}
	>
}): Promise<void> {
	if (input.rows.length === 0) return
	await input.db.batch(
		input.rows.map((row) => {
			const { placementOnInsert, placementOriginOnInsert, ...entry } = row
			return prepareUpsertSecretEntryStatement({
				db: input.db,
				row: entry,
				newCredentialPlacementJson:
					placementOnInsert !== undefined
						? serializeCredentialFillPlacement(placementOnInsert ?? null)
						: newCredentialPlacementJson,
				newCredentialPlacementOrigin: placementOriginOnInsert ?? null,
			})
		}),
	)
}

function prepareUpdateApprovedUserSecretEntryForPackageStatement(input: {
	db: D1Database
	userId: string
	packageId: string
	name: string
	description: string
	encryptedValue: string
	updatedAt: string
}): D1PreparedStatement {
	return input.db
		.prepare(
			`UPDATE secret_entries
			SET description = ?, encrypted_value = ?, updated_at = ?
			WHERE name = ?
				AND bucket_id = (
					SELECT id
					FROM secret_buckets
					WHERE user_id = ? AND scope = 'user' AND binding_key = ''
						AND deleted_at IS NULL
					LIMIT 1
				)
				AND json_valid(allowed_packages)
				AND EXISTS (
					SELECT 1
					FROM json_each(allowed_packages)
					WHERE value = ?
				)${andLiveDeletedAtSql()}`,
		)
		.bind(
			input.description,
			input.encryptedValue,
			input.updatedAt,
			input.name,
			input.userId,
			input.packageId,
		)
}

export async function updateApprovedUserSecretEntryForPackage(input: {
	db: D1Database
	userId: string
	packageId: string
	name: string
	description: string
	encryptedValue: string
	updatedAt: string
}): Promise<boolean> {
	const result =
		await prepareUpdateApprovedUserSecretEntryForPackageStatement(input).run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * Atomically update multiple package-approved user secrets. Uses one UPDATE so
 * either every named secret is rewritten or none are (fail-closed when any
 * secret is missing or lacks the package in `allowed_packages`). Statement
 * order of `updates` is preserved in the CASE bindings for determinism.
 */
export async function updateApprovedUserSecretEntriesForPackageAtomically(input: {
	db: D1Database
	userId: string
	packageId: string
	updates: Array<{
		name: string
		description: string
		encryptedValue: string
		updatedAt: string
	}>
}): Promise<void> {
	if (input.updates.length === 0) return
	if (input.updates.length === 1) {
		const only = input.updates[0]
		if (!only) return
		const updated = await updateApprovedUserSecretEntryForPackage({
			db: input.db,
			userId: input.userId,
			packageId: input.packageId,
			name: only.name,
			description: only.description,
			encryptedValue: only.encryptedValue,
			updatedAt: only.updatedAt,
		})
		if (!updated) {
			throw new Error('package cannot mutate one or more secrets')
		}
		return
	}

	const names = input.updates.map((update) => update.name)
	const namePlaceholders = names.map(() => '?').join(', ')
	const descriptionCase = names.map(() => 'WHEN ? THEN ?').join(' ')
	const encryptedCase = names.map(() => 'WHEN ? THEN ?').join(' ')
	const updatedAt = input.updates[0]?.updatedAt
	if (!updatedAt) {
		throw new Error('At least one secret update is required.')
	}

	const result = await input.db
		.prepare(
			`UPDATE secret_entries
			SET
				description = CASE name ${descriptionCase} ELSE description END,
				encrypted_value = CASE name ${encryptedCase} ELSE encrypted_value END,
				updated_at = ?
			WHERE name IN (${namePlaceholders})
				AND bucket_id = (
					SELECT id
					FROM secret_buckets
					WHERE user_id = ? AND scope = 'user' AND binding_key = ''
						AND deleted_at IS NULL
					LIMIT 1
				)
				AND json_valid(allowed_packages)
				AND EXISTS (
					SELECT 1
					FROM json_each(allowed_packages)
					WHERE value = ?
				)
				AND (
					SELECT COUNT(*)
					FROM secret_entries e
					JOIN secret_buckets b ON b.id = e.bucket_id
					WHERE b.user_id = ?
						AND b.scope = 'user'
						AND b.binding_key = ''
						AND e.name IN (${namePlaceholders})
						AND json_valid(e.allowed_packages)
						AND EXISTS (
							SELECT 1
							FROM json_each(e.allowed_packages)
							WHERE value = ?
						)
						AND e.deleted_at IS NULL
						AND b.deleted_at IS NULL
				) = ?${andLiveDeletedAtSql()}`,
		)
		.bind(
			...input.updates.flatMap((update) => [update.name, update.description]),
			...input.updates.flatMap((update) => [
				update.name,
				update.encryptedValue,
			]),
			updatedAt,
			...names,
			input.userId,
			input.packageId,
			input.userId,
			...names,
			input.packageId,
			names.length,
		)
		.run()

	if ((result.meta.changes ?? 0) !== names.length) {
		throw new Error('package cannot mutate one or more secrets')
	}
}

/**
 * Rename a live secret entry in place (same row, same credential id). Names
 * compare exactly: lookup and uniqueness are case-sensitive, so a case-only
 * change such as Henry → henry must update the stored name.
 */
export async function renameSecretEntry(input: {
	db: D1Database
	bucketId: string
	fromName: string
	toName: string
	updatedAt?: string
}): Promise<boolean> {
	const fromName = input.fromName.trim()
	const toName = input.toName.trim()
	if (!fromName || !toName) {
		throw new Error('Secret name is required.')
	}
	if (fromName === toName) return false
	const updatedAt = input.updatedAt ?? new Date().toISOString()
	const result = await input.db
		.prepare(
			`UPDATE secret_entries
			SET name = ?, updated_at = ?
			WHERE bucket_id = ? AND name = ?${andLiveDeletedAtSql()}`,
		)
		.bind(toName, updatedAt, input.bucketId, fromName)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function deleteSecretEntry(input: {
	db: D1Database
	userId: string
	bucketId: string
	name: string
}): Promise<boolean> {
	const liveRowSql = `FROM secret_entries WHERE bucket_id = ? AND name = ?${andLiveDeletedAtSql()}`
	const results = await input.db.batch([
		...credentialGrantCleanupStatements(input.db, {
			ownerId: input.userId,
			credentialIdSql: `SELECT id ${liveRowSql}`,
			credentialIdBindings: [input.bucketId, input.name],
		}),
		input.db.prepare(`DELETE ${liveRowSql}`).bind(input.bucketId, input.name),
	])
	return (results.at(-1)?.meta.changes ?? 0) > 0
}

export async function listSecretBucketsByScope(input: {
	db: D1Database
	userId: string
	scope: SecretScope
	now?: string
}): Promise<Array<SecretBucketRow>> {
	const now = input.now ?? new Date().toISOString()
	const { results } = await input.db
		.prepare(
			`SELECT id, user_id, scope, binding_key, expires_at, created_at, updated_at
			FROM secret_buckets
			WHERE user_id = ? AND scope = ?
				AND (expires_at IS NULL OR expires_at > ?)${andLiveDeletedAtSql()}
			ORDER BY binding_key ASC`,
		)
		.bind(input.userId, input.scope, now)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapSecretBucketRow)
}

export async function listSecretMetadataForBucket(input: {
	db: D1Database
	bucket: SecretBucketRow
}): Promise<Array<SecretMetadataRow>> {
	const { results } = await input.db
		.prepare(
			`SELECT id, ? AS scope, ? AS binding_key, name, description, allowed_hosts, allowed_packages, created_at, updated_at, expires_at AS entry_expires_at, ? AS bucket_expires_at, placement_json, placement_origin, encrypted_value
			FROM secret_entries
			WHERE bucket_id = ?${andLiveDeletedAtSql()}
			ORDER BY name ASC`,
		)
		.bind(
			input.bucket.scope,
			input.bucket.binding_key,
			input.bucket.expires_at,
			input.bucket.id,
		)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapSecretMetadataRow)
}

export async function listUserScopeSecretMetadata(input: {
	db: D1Database
	userId: string
	now?: string
}): Promise<Array<SecretMetadataRow>> {
	const now = input.now ?? new Date().toISOString()
	const { results } = await input.db
		.prepare(
			`SELECT e.id, b.scope, b.binding_key, e.name, e.description, e.allowed_hosts, e.allowed_packages, e.created_at, e.updated_at, e.expires_at AS entry_expires_at, b.expires_at AS bucket_expires_at, e.placement_json AS placement_json, e.placement_origin AS placement_origin, e.encrypted_value AS encrypted_value
			FROM secret_buckets b
			JOIN secret_entries e ON e.bucket_id = b.id
			WHERE b.user_id = ? AND b.scope = 'user'
				AND (b.expires_at IS NULL OR b.expires_at > ?)${andLiveDeletedAtSql('b')}${andLiveDeletedAtSql('e')}
			ORDER BY e.name ASC`,
		)
		.bind(input.userId, now)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapSecretMetadataRow)
}

export type SecretLocationRow = {
	scope: SecretScope
	binding_key: string
	name: string
	expires_at: string | null
}

/**
 * Same-user locations for a secret name across every scope/binding. Does not
 * return ciphertext. Used to distinguish a true miss from a scope the current
 * runtime cannot see.
 */
export async function listSecretLocationsByNameForUser(input: {
	db: D1Database
	userId: string
	name: string
	now?: string
}): Promise<Array<SecretLocationRow>> {
	const now = input.now ?? new Date().toISOString()
	const { results } = await input.db
		.prepare(
			`SELECT e.id, b.scope, b.binding_key, e.name, e.expires_at AS entry_expires_at, b.expires_at AS bucket_expires_at
			FROM secret_buckets b
			JOIN secret_entries e ON e.bucket_id = b.id
			WHERE b.user_id = ? AND e.name = ?
				AND (b.expires_at IS NULL OR b.expires_at > ?)
				AND (e.expires_at IS NULL OR e.expires_at > ?)${andLiveDeletedAtSql('b')}${andLiveDeletedAtSql('e')}
			ORDER BY b.scope ASC, b.binding_key ASC`,
		)
		.bind(input.userId, input.name, now, now)
		.all<Record<string, unknown>>()
	return (results ?? []).map((row) => {
		const mapped = mapSecretMetadataRow(row)
		return {
			scope: mapped.scope,
			binding_key: mapped.binding_key,
			name: mapped.name,
			expires_at: mapped.expires_at,
		}
	})
}

export async function listPackageScopeSecretMetadata(input: {
	db: D1Database
	userId: string
	packageIds: Array<string>
	now?: string
}): Promise<Array<SecretMetadataRow>> {
	if (input.packageIds.length === 0) return []
	const now = input.now ?? new Date().toISOString()
	const uniquePackageIds = [...new Set(input.packageIds)]
	const rows: Array<SecretMetadataRow> = []
	// `/account/secrets` lists every saved package, then binds those ids in one
	// IN (...). userId + now are two extra params; 99+ packages exceeds D1's
	// 100-binding cap (`too many SQL variables`) and 500s the page.
	for (const idChunk of chunkArray(
		uniquePackageIds,
		maxD1BoundParameters - listPackageScopeSecretFixedBindings,
	)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const { results } = await input.db
			.prepare(
				`SELECT e.id, b.scope, b.binding_key, e.name, e.description, e.allowed_hosts, e.allowed_packages, e.created_at, e.updated_at, e.expires_at AS entry_expires_at, b.expires_at AS bucket_expires_at, e.placement_json AS placement_json, e.placement_origin AS placement_origin, e.encrypted_value AS encrypted_value
				FROM secret_buckets b
				JOIN secret_entries e ON e.bucket_id = b.id
				WHERE b.user_id = ? AND b.scope = 'package'
					AND b.binding_key IN (${placeholders})
					AND (b.expires_at IS NULL OR b.expires_at > ?)${andLiveDeletedAtSql('b')}${andLiveDeletedAtSql('e')}
				ORDER BY e.name ASC`,
			)
			.bind(input.userId, ...idChunk, now)
			.all<Record<string, unknown>>()
		for (const row of results ?? []) {
			rows.push(mapSecretMetadataRow(row))
		}
	}
	return rows.sort((left, right) => left.name.localeCompare(right.name))
}

function mapSecretBucketRow(row: Record<string, unknown>): SecretBucketRow {
	return {
		id: String(row['id']),
		user_id: String(row['user_id']),
		scope: String(row['scope']) as SecretScope,
		binding_key: String(row['binding_key']),
		expires_at: row['expires_at'] == null ? null : String(row['expires_at']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}

function readPlacementOrigin(value: unknown): CredentialPlacementOrigin | null {
	return isCredentialPlacementOrigin(value) ? value : null
}

function mapSecretEntryRow(row: Record<string, unknown>): SecretEntryRow {
	return {
		id: String(row['id']),
		bucket_id: String(row['bucket_id']),
		name: String(row['name']),
		description: String(row['description']),
		encrypted_value: String(row['encrypted_value']),
		allowed_hosts: String(row['allowed_hosts']),
		allowed_packages: String(row['allowed_packages']),
		expires_at: row['expires_at'] == null ? null : String(row['expires_at']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}

function mapSecretMetadataRow(row: Record<string, unknown>): SecretMetadataRow {
	const entryExpiresAt =
		row['entry_expires_at'] == null ? null : String(row['entry_expires_at'])
	const bucketExpiresAt =
		row['bucket_expires_at'] == null
			? row['expires_at'] == null
				? null
				: String(row['expires_at'])
			: String(row['bucket_expires_at'])
	const encryptedValue =
		row['encrypted_value'] == null ? null : String(row['encrypted_value'])
	return {
		id: String(row['id']),
		scope: String(row['scope']) as SecretScope,
		binding_key: String(row['binding_key']),
		name: String(row['name']),
		description: String(row['description']),
		allowed_hosts: String(row['allowed_hosts']),
		allowed_packages: String(row['allowed_packages']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
		expires_at: earliestSecretExpiresAt(entryExpiresAt, bucketExpiresAt),
		placement_json:
			row['placement_json'] == null ? null : String(row['placement_json']),
		placement_origin: readPlacementOrigin(row['placement_origin']),
		disconnected: isDisconnectedSecretEncryptedValue(encryptedValue),
	}
}

/**
 * Clear the secret value while keeping the row, placement, hosts, and grants.
 * Empty ciphertext is the disconnected sentinel. Does not touch grants.
 */
export async function clearSecretValueEntry(input: {
	db: D1Database
	bucketId: string
	name: string
	updatedAt: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`UPDATE secret_entries
			SET encrypted_value = ?, updated_at = ?
			WHERE bucket_id = ? AND name = ?${andLiveDeletedAtSql()}`,
		)
		.bind(
			disconnectedSecretEncryptedValue,
			input.updatedAt,
			input.bucketId,
			input.name,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}
