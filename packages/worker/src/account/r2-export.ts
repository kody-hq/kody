import { fileObjectReader } from '#worker/files/object-storage.ts'
import { fileStoreRpc } from '#worker/files/client.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { buildCommunityIconR2Key } from '#worker/community/community-icon.ts'
import {
	buildIdentityIconR2Key,
	identityIconCommitForKind,
} from '#worker/repo/identity-icon.ts'
import { type EntityKind } from '#worker/repo/types.ts'
import {
	type AccountMailboxEmailObjectSource,
	countMailboxEmailObjectRefs,
	listMailboxEmailObjectRefPage,
	resolveMailboxEmailObjectRef,
} from './mailbox-r2-references.ts'
import {
	type AccountR2Binding,
	type AccountR2ObjectRef,
} from './r2-inventory.ts'

// v1 traversed D1 email rows, so its continuation cannot be translated to the
// Mailbox keyset without risking duplicate bytes. Signed v1 cursors fail with
// an explicit restart instruction instead.
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
const accountR2CursorVersion = 3
const accountR2ChunkBytes = 256 * 1024

type R2ScanState =
	| { stage: 'avatar' }
	| { stage: 'community_icon'; afterRowid: number }
	| { stage: 'identity_icon'; afterRowid: number }
	| { stage: 'mailbox_email_blob'; startAfter: string | null }
	| { stage: 'file_blob'; startAfter: string | null }
	| { stage: 'done' }

type R2ObjectSource =
	| { kind: 'avatar' }
	| {
			kind: 'community_icon'
			rowid: number
			listingId: string
			commitSlot: 'pinned' | 'icon'
	  }
	| {
			kind: 'identity_icon'
			rowid: number
			repoId: string
	  }
	| { kind: 'file_blob' }
	| AccountMailboxEmailObjectSource

type StableR2Ref = AccountR2ObjectRef & { source: R2ObjectSource }

type R2Cursor = {
	v: typeof accountR2CursorVersion
	state: R2ScanState
	current?: {
		ref: StableR2Ref
		offset: number
		etag?: string
		size?: number
	}
	pending?: StableR2Ref
}

function encodeBase64UrlBytes(bytes: Uint8Array) {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '')
}

function encodeBase64Url(value: string) {
	return encodeBase64UrlBytes(new TextEncoder().encode(value))
}

function decodeBase64UrlBytes(value: string) {
	const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
	const binary = atob(padded)
	return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function decodeBase64Url(value: string) {
	return new TextDecoder().decode(decodeBase64UrlBytes(value))
}

async function cursorHmacKey(env: Env) {
	return await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(env.COOKIE_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	)
}

async function encodeCursor(env: Env, userId: OwnerId, cursor: R2Cursor) {
	const payload = encodeBase64Url(JSON.stringify({ userId, cursor }))
	const signature = await crypto.subtle.sign(
		'HMAC',
		await cursorHmacKey(env),
		new TextEncoder().encode(payload),
	)
	return `${payload}.${encodeBase64UrlBytes(new Uint8Array(signature))}`
}

function isScanState(value: unknown): value is R2ScanState {
	if (!value || typeof value !== 'object' || !('stage' in value)) return false
	const stage = (value as { stage: unknown }).stage
	if (stage === 'avatar' || stage === 'done') return true
	if (stage === 'mailbox_email_blob' || stage === 'file_blob') {
		return (
			'startAfter' in value &&
			((value as { startAfter: unknown }).startAfter === null ||
				typeof (value as { startAfter: unknown }).startAfter === 'string')
		)
	}
	return (
		(stage === 'community_icon' || stage === 'identity_icon') &&
		'afterRowid' in value &&
		Number.isSafeInteger((value as { afterRowid: unknown }).afterRowid) &&
		(value as { afterRowid: number }).afterRowid >= 0
	)
}

async function decodeCursor(
	env: Env,
	userId: OwnerId,
	value: string | undefined,
): Promise<R2Cursor> {
	if (!value) {
		return { v: accountR2CursorVersion, state: { stage: 'avatar' } }
	}
	try {
		const [payload, signature, extra] = value.split('.')
		if (!payload || !signature || extra) throw new Error('invalid envelope')
		const valid = await crypto.subtle.verify(
			'HMAC',
			await cursorHmacKey(env),
			decodeBase64UrlBytes(signature),
			new TextEncoder().encode(payload),
		)
		if (!valid) throw new Error('invalid signature')
		const envelope = JSON.parse(decodeBase64Url(payload)) as {
			userId?: unknown
			cursor?: unknown
		}
		if (envelope.userId !== userId) throw new Error('wrong user')
		const parsed = envelope.cursor as R2Cursor
		if (parsed.v !== accountR2CursorVersion || !isScanState(parsed.state)) {
			throw new Error('unsupported cursor')
		}
		return parsed
	} catch {
		throw new Error(
			'Invalid or unsupported r2_object cursor; restart without startAfter.',
		)
	}
}

function bucketFor(env: Env, binding: AccountR2Binding) {
	if (binding === 'FILE_BLOBS') return env.FILE_BLOBS
	return binding === 'EMAIL_BLOBS' ? env.EMAIL_BLOBS : env.COMMUNITY_ASSETS
}

async function findNextRef(input: {
	env: Env
	userId: OwnerId
	dbUserId: number
	cursor: R2Cursor
}): Promise<R2Cursor> {
	let cursor = input.cursor
	while (!cursor.current) {
		if (cursor.pending) {
			return {
				v: accountR2CursorVersion,
				state: cursor.state,
				current: { ref: cursor.pending, offset: 0 },
			}
		}
		switch (cursor.state.stage) {
			case 'avatar': {
				const row = await input.env.APP_DB.prepare(
					`SELECT avatar_key FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
				)
					.bind(input.dbUserId)
					.first<{ avatar_key: string | null }>()
				cursor = {
					v: accountR2CursorVersion,
					state: { stage: 'community_icon', afterRowid: 0 },
					...(row?.avatar_key
						? {
								current: {
									ref: {
										surfaceId: 'user_avatar',
										binding: 'COMMUNITY_ASSETS',
										key: row.avatar_key,
										source: { kind: 'avatar' },
									},
									offset: 0,
								},
							}
						: {}),
				}
				break
			}
			case 'community_icon': {
				const row = await input.env.APP_DB.prepare(
					`SELECT community_listings.rowid AS source_rowid,
						community_listings.id, community_listings.pinned_commit,
						entity_sources.published_commit AS source_published_commit
					FROM community_listings
					LEFT JOIN entity_sources
						ON entity_sources.id = community_listings.source_id
						AND entity_sources.user_id = community_listings.owner_user_id
						AND entity_sources.entity_kind = 'package'
						AND entity_sources.entity_id = community_listings.package_id
						AND entity_sources.deleted_at IS NULL
					WHERE community_listings.owner_user_id = ?
						AND community_listings.rowid > ?${andLiveDeletedAtSql('community_listings')}
					ORDER BY community_listings.rowid LIMIT 1`,
				)
					.bind(input.userId, cursor.state.afterRowid)
					.first<{
						source_rowid: number
						id: string
						pinned_commit: string
						source_published_commit: string | null
					}>()
				if (!row) {
					cursor = {
						v: accountR2CursorVersion,
						state: { stage: 'identity_icon', afterRowid: 0 },
					}
					break
				}
				const commits = Array.from(
					new Set([
						row.pinned_commit,
						row.source_published_commit ?? row.pinned_commit,
					]),
				)
				const refs = commits.map((commit, index): StableR2Ref => ({
					surfaceId: 'community_icon',
					binding: 'COMMUNITY_ASSETS',
					key: buildCommunityIconR2Key({
						listingId: row.id,
						commit,
					}),
					source: {
						kind: 'community_icon',
						rowid: row.source_rowid,
						listingId: row.id,
						commitSlot: index === 0 ? 'pinned' : 'icon',
					},
				}))
				cursor = {
					v: accountR2CursorVersion,
					state: {
						stage: 'community_icon',
						afterRowid: row.source_rowid,
					},
					current: { ref: refs[0]!, offset: 0 },
					...(refs[1] ? { pending: refs[1] } : {}),
				}
				break
			}
			case 'identity_icon': {
				const row = await input.env.APP_DB.prepare(
					`SELECT entity_sources.rowid AS source_rowid,
						entity_sources.repo_id,
						entity_sources.entity_kind,
						entity_sources.published_commit,
						entity_sources.indexed_commit
					FROM entity_sources
					WHERE entity_sources.user_id = ?
						AND entity_sources.rowid > ?${andLiveDeletedAtSql('entity_sources')}
					ORDER BY entity_sources.rowid LIMIT 1`,
				)
					.bind(input.userId, cursor.state.afterRowid)
					.first<{
						source_rowid: number
						repo_id: string
						entity_kind: EntityKind
						published_commit: string | null
						indexed_commit: string | null
					}>()
				if (!row) {
					cursor = {
						v: accountR2CursorVersion,
						state: { stage: 'mailbox_email_blob', startAfter: null },
					}
					break
				}
				const iconCommit = identityIconCommitForKind({
					entityKind: row.entity_kind,
					publishedCommit: row.published_commit,
					indexedCommit: row.indexed_commit,
				})
				cursor = {
					v: accountR2CursorVersion,
					state: {
						stage: 'identity_icon',
						afterRowid: row.source_rowid,
					},
					...(iconCommit
						? {
								current: {
									ref: {
										surfaceId: 'identity_icon' as const,
										binding: 'COMMUNITY_ASSETS' as const,
										key: buildIdentityIconR2Key({
											repoId: row.repo_id,
											commit: iconCommit,
										}),
										source: {
											kind: 'identity_icon' as const,
											rowid: row.source_rowid,
											repoId: row.repo_id,
										},
									},
									offset: 0,
								},
							}
						: {}),
				}
				break
			}
			case 'mailbox_email_blob': {
				const startAfter = cursor.state.startAfter
				const page = await listMailboxEmailObjectRefPage({
					env: input.env,
					ownerId: input.userId,
					pageSize: 1,
					startAfter,
				})
				const reference = page.references[0]
				if (!reference) {
					if (page.truncated && page.nextStartAfter != null) {
						cursor = {
							v: accountR2CursorVersion,
							state: {
								stage: 'mailbox_email_blob',
								startAfter: page.nextStartAfter,
							},
						}
						break
					}
					cursor = {
						v: accountR2CursorVersion,
						state: { stage: 'file_blob', startAfter: null },
					}
					break
				}
				cursor = {
					v: accountR2CursorVersion,
					state:
						page.truncated && page.nextStartAfter != null
							? {
									stage: 'mailbox_email_blob',
									startAfter: page.nextStartAfter,
								}
							: { stage: 'file_blob', startAfter: null },
					current: {
						ref: reference,
						offset: 0,
					},
				}
				break
			}
			case 'file_blob': {
				const keys = input.env.FILE_STORE
					? await fileStoreRpc(input.env, input.userId).inventory(input.userId)
					: []
				const after = cursor.state.startAfter
				const key = keys.find((key) => after === null || key > after)
				cursor = key
					? {
							v: accountR2CursorVersion,
							state: { stage: 'file_blob', startAfter: key },
							current: {
								offset: 0,
								ref: {
									surfaceId: 'file_revision',
									binding: 'FILE_BLOBS',
									key,
									source: { kind: 'file_blob' },
								},
							},
						}
					: { v: accountR2CursorVersion, state: { stage: 'done' } }
				break
			}
			case 'done': {
				return cursor
			}
			default: {
				const exhaustive: never = cursor.state
				throw new Error(
					`Unhandled R2 scan state: ${JSON.stringify(exhaustive)}`,
				)
			}
		}
	}
	return cursor
}

async function resolveCurrentRef(input: {
	env: Env
	userId: OwnerId
	dbUserId: number
	ref: StableR2Ref
}): Promise<AccountR2ObjectRef | null> {
	switch (input.ref.source.kind) {
		case 'avatar': {
			const row = await input.env.APP_DB.prepare(
				`SELECT avatar_key FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
			)
				.bind(input.dbUserId)
				.first<{ avatar_key: string | null }>()
			return row?.avatar_key === input.ref.key ? input.ref : null
		}
		case 'community_icon': {
			const row = await input.env.APP_DB.prepare(
				`SELECT community_listings.pinned_commit,
					entity_sources.published_commit AS source_published_commit
				FROM community_listings
				LEFT JOIN entity_sources
					ON entity_sources.id = community_listings.source_id
					AND entity_sources.user_id = community_listings.owner_user_id
					AND entity_sources.entity_kind = 'package'
					AND entity_sources.entity_id = community_listings.package_id
					AND entity_sources.deleted_at IS NULL
				WHERE community_listings.owner_user_id = ?
					AND community_listings.rowid = ?
					AND community_listings.id = ?${andLiveDeletedAtSql('community_listings')}`,
			)
				.bind(input.userId, input.ref.source.rowid, input.ref.source.listingId)
				.first<{
					pinned_commit: string
					source_published_commit: string | null
				}>()
			if (!row) return null
			const commit =
				input.ref.source.commitSlot === 'pinned'
					? row.pinned_commit
					: (row.source_published_commit ?? row.pinned_commit)
			return buildCommunityIconR2Key({
				listingId: input.ref.source.listingId,
				commit,
			}) === input.ref.key
				? input.ref
				: null
		}
		case 'identity_icon': {
			const row = await input.env.APP_DB.prepare(
				`SELECT entity_sources.repo_id,
					entity_sources.entity_kind,
					entity_sources.published_commit,
					entity_sources.indexed_commit
				FROM entity_sources
				WHERE entity_sources.user_id = ?
					AND entity_sources.rowid = ?
					AND entity_sources.repo_id = ?${andLiveDeletedAtSql('entity_sources')}`,
			)
				.bind(input.userId, input.ref.source.rowid, input.ref.source.repoId)
				.first<{
					repo_id: string
					entity_kind: EntityKind
					published_commit: string | null
					indexed_commit: string | null
				}>()
			if (!row) return null
			const iconCommit = identityIconCommitForKind({
				entityKind: row.entity_kind,
				publishedCommit: row.published_commit,
				indexedCommit: row.indexed_commit,
			})
			return iconCommit &&
				buildIdentityIconR2Key({
					repoId: row.repo_id,
					commit: iconCommit,
				}) === input.ref.key
				? input.ref
				: null
		}
		case 'file_blob': {
			if (input.ref.binding !== 'FILE_BLOBS' || !input.env.FILE_STORE)
				return null
			const keys = await fileStoreRpc(input.env, input.userId).inventory(
				input.userId,
			)
			return keys.includes(input.ref.key) ? input.ref : null
		}
		case 'mailbox_email_blob': {
			return await resolveMailboxEmailObjectRef({
				env: input.env,
				ownerId: input.userId,
				source: input.ref.source,
				expectedKey: input.ref.key,
			})
		}
		default: {
			const exhaustive: never = input.ref.source
			throw new Error(`Unhandled R2 source: ${JSON.stringify(exhaustive)}`)
		}
	}
}

function cursorAfterCurrent(cursor: R2Cursor): R2Cursor {
	return {
		v: accountR2CursorVersion,
		state: cursor.state,
		...(cursor.pending ? { current: { ref: cursor.pending, offset: 0 } } : {}),
	}
}

function encodeBytesBase64(bytes: Uint8Array) {
	let binary = ''
	const blockSize = 32 * 1024
	for (let offset = 0; offset < bytes.length; offset += blockSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize))
	}
	return btoa(binary)
}

export async function readAccountR2ExportPage(input: {
	env: Env
	userId: OwnerId
	dbUserId: number
	startAfter?: string
	warnings: Array<string>
}) {
	const cursor = await findNextRef({
		env: input.env,
		userId: input.userId,
		dbUserId: input.dbUserId,
		cursor: await decodeCursor(input.env, input.userId, input.startAfter),
	})
	if (!cursor.current) {
		return {
			items: [] as Array<unknown>,
			truncated: false,
			nextStartAfter: null,
		}
	}
	const current = cursor.current
	const ref = await resolveCurrentRef({
		env: input.env,
		userId: input.userId,
		dbUserId: input.dbUserId,
		ref: current.ref,
	})
	const after = cursorAfterCurrent(cursor)
	if (!ref) {
		input.warnings.push(
			`R2 export source changed for ${current.ref.binding}/${current.ref.key}.`,
		)
		return {
			items: [
				{
					...current.ref,
					source: undefined,
					changed: true,
					change: 'ownership_or_key_changed',
				},
			],
			truncated: true,
			nextStartAfter: await encodeCursor(input.env, input.userId, after),
		}
	}
	const bucket =
		ref.binding === 'FILE_BLOBS'
			? fileObjectReader(input.env, input.userId)
			: bucketFor(input.env, ref.binding)
	try {
		if (current.offset > 0) {
			const head = await bucket.head(ref.key)
			if (
				!head ||
				head.httpEtag !== current.etag ||
				head.size !== current.size
			) {
				input.warnings.push(
					`R2 object changed during export for ${ref.binding}/${ref.key}.`,
				)
				return {
					items: [
						{
							...ref,
							changed: true,
							change: 'object_overwritten',
							expectedEtag: current.etag,
							actualEtag: head?.httpEtag ?? null,
						},
					],
					truncated: true,
					nextStartAfter: await encodeCursor(input.env, input.userId, after),
				}
			}
		}
		const object = await bucket.get(ref.key, {
			range: { offset: current.offset, length: accountR2ChunkBytes },
		})
		if (!object) {
			return {
				items: [{ ...ref, missing: true }],
				truncated: true,
				nextStartAfter: await encodeCursor(input.env, input.userId, after),
			}
		}
		if (
			current.etag !== undefined &&
			(object.httpEtag !== current.etag || object.size !== current.size)
		) {
			input.warnings.push(
				`R2 object changed during export for ${ref.binding}/${ref.key}.`,
			)
			return {
				items: [
					{
						...ref,
						changed: true,
						change: 'object_overwritten',
						expectedEtag: current.etag,
						actualEtag: object.httpEtag,
					},
				],
				truncated: true,
				nextStartAfter: await encodeCursor(input.env, input.userId, after),
			}
		}
		const bytes = new Uint8Array(await object.arrayBuffer())
		const nextOffset = current.offset + bytes.byteLength
		const objectComplete = nextOffset >= object.size
		return {
			items: [
				{
					...ref,
					offset: current.offset,
					size: object.size,
					contentType: object.httpMetadata?.contentType ?? null,
					etag: object.httpEtag,
					contentBase64: encodeBytesBase64(bytes),
					objectComplete,
				},
			],
			truncated: true,
			nextStartAfter: await encodeCursor(
				input.env,
				input.userId,
				objectComplete
					? after
					: {
							...cursor,
							current: {
								ref: current.ref,
								offset: nextOffset,
								etag: object.httpEtag,
								size: object.size,
							},
						},
			),
		}
	} catch (error) {
		input.warnings.push(
			`R2 object export failed for ${ref.binding}/${ref.key}: ${getErrorMessage(error)}`,
		)
		return {
			items: [{ ...ref, unavailable: true }],
			truncated: true,
			nextStartAfter: await encodeCursor(input.env, input.userId, after),
		}
	}
}

export async function countAccountR2ObjectRefs(input: {
	env: Env
	userId: OwnerId
	dbUserId: number
}) {
	const [emailBlobs, icons, identityIcons, avatar] = await Promise.all([
		countMailboxEmailObjectRefs({
			env: input.env,
			ownerId: input.userId,
		}),
		input.env.APP_DB.prepare(
			`SELECT COALESCE(SUM(
				CASE
					WHEN entity_sources.published_commit IS NULL
						OR entity_sources.published_commit = community_listings.pinned_commit
					THEN 1 ELSE 2
				END
			), 0) AS count
			FROM community_listings
			LEFT JOIN entity_sources
				ON entity_sources.id = community_listings.source_id
				AND entity_sources.user_id = community_listings.owner_user_id
				AND entity_sources.entity_kind = 'package'
				AND entity_sources.entity_id = community_listings.package_id
				AND entity_sources.deleted_at IS NULL
			WHERE community_listings.owner_user_id = ?${andLiveDeletedAtSql('community_listings')}`,
		)
			.bind(input.userId)
			.first<{ count: number }>(),
		input.env.APP_DB.prepare(
			`SELECT COUNT(*) AS count
			FROM entity_sources
			WHERE entity_sources.user_id = ?
				AND (
					(entity_sources.entity_kind = 'package'
						AND entity_sources.published_commit IS NOT NULL)
					OR (entity_sources.entity_kind <> 'package'
						AND COALESCE(
							entity_sources.indexed_commit,
							entity_sources.published_commit
						) IS NOT NULL)
				)${andLiveDeletedAtSql('entity_sources')}`,
		)
			.bind(input.userId)
			.first<{ count: number }>(),
		input.env.APP_DB.prepare(
			`SELECT CASE WHEN avatar_key IS NULL OR TRIM(avatar_key) = ''
				THEN 0 ELSE 1 END AS count
			FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
		)
			.bind(input.dbUserId)
			.first<{ count: number }>(),
	])
	return (
		(input.env.FILE_STORE
			? (await fileStoreRpc(input.env, input.userId).inventory(input.userId))
					.length
			: 0) +
		emailBlobs +
		Number(icons?.count ?? 0) +
		Number(identityIcons?.count ?? 0) +
		Number(avatar?.count ?? 0)
	)
}
