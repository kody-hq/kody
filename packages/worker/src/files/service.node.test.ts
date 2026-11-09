import { type FileMetadata } from '#universal/files.ts'
import { inviteCreateCapability } from '#mcp/capabilities/access/invites.ts'
import { fileInvitationOffer, acceptFileInvitation } from './invitations.ts'
import { createProfile, revokeProfile } from '#worker/profiles/service.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { expect, test, vi } from 'vitest'
import {
	personIdFromStored,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	createMigratedDb,
	insertTestUser,
} from '#worker/test-support/account-export.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import {
	createTeam,
	softDeleteGrant,
	upsertGrant,
} from '#worker/orgs/access-writes.ts'
import { listResourceCollaborators } from '#worker/orgs/package-collaborators.ts'
import { authorizeGrantTarget } from '#mcp/capabilities/access/shared.ts'
import {
	deleteFile,
	getFile,
	getFileDescriptor,
	getFileAsset,
	listFiles,
	writeFile,
	manageFile,
	patchPage,
} from './service.ts'

async function fixture() {
	const { sqlite } = createMigratedDb()
	const db = createD1FromSqlite(sqlite)
	const audit = createTestOrgAuditWriter({ appDb: db })
	const owner = 'a'.repeat(64),
		reader = 'b'.repeat(64)
	insertTestUser(sqlite, { id: 1, username: 'file-owner', stableUserId: owner })
	insertTestUser(sqlite, {
		id: 2,
		username: 'file-reader',
		stableUserId: reader,
	})
	await provisionPersonalOrg(db, {
		stableUserId: owner,
		username: 'file-owner',
	})
	sqlite
		.prepare(
			"INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'member', 'now')",
		)
		.run(owner, reader)
	const file = {
		id: crypto.randomUUID(),
		name: 'Private.md',
		mediaType: 'text/markdown' as const,
		revisionId: crypto.randomUUID(),
		revisions: [] as FileMetadata['revisions'],
		createdAt: 'now',
		updatedAt: 'now',
	}
	const hidden = {
		...file,
		id: crypto.randomUUID(),
		name: 'Other private file.md',
	}
	const store = {
		revision: vi.fn(async () => null),
		objectProvider: vi.fn(async () => null),
		storageStatus: vi.fn(async () => ({ active: null, providers: [] })),
		list: vi.fn(async () => [file, hidden]),
		metadata: vi.fn(
			async (_owner: string, _id: string): Promise<FileMetadata> => file,
		),
		read: vi.fn(async () => ({ ...file, content: 'private text' })),
		write: vi.fn(async (input) => ({
			ok: true as const,
			file: { ...file, id: input.fileId, content: input.content },
		})),
		remove: vi.fn(async () => true),
	}
	const env = {
		APP_DB: db,
		AUDIT_DB: audit.db,
		SENTRY_ENVIRONMENT: 'test',
		FILES_INCLUDED_BYTES: '1048576',
		...createInMemoryUserMeterEnv().env,
		FILE_STORE: { idFromName: (name: string) => name, get: () => store },
	} as unknown as Env
	const context = (
		person = reader,
		role: 'owner' | 'member' | null = 'member',
	) =>
		({
			env,
			callerContext: createMcpCallerContext({
				baseUrl: 'http://localhost',
				source: { kind: 'session' },
				user: {
					userId: personIdFromStored(person),
					username: person === owner ? 'file-owner' : 'file-reader',
					email:
						person === owner
							? 'file-owner@example.com'
							: 'file-reader@example.com',
					displayName: 'Files test',
				},
				orgBinding: {
					org: { id: ownerIdFromStored(owner), slug: 'file-owner' },
					role,
				},
			}),
		}) satisfies CapabilityContext
	const grant = (
		resourceType: 'file' | 'org',
		resourceId: string,
		permissions: Parameters<typeof upsertGrant>[0]['permissions'],
	) =>
		upsertGrant({
			db,
			orgId: owner,
			resourceType,
			resourceId,
			subject: { type: 'user', id: reader },
			preset: null,
			permissions,
			createdByUserId: owner,
			audit,
		})
	return {
		sqlite,
		db,
		audit,
		owner,
		reader,
		file,
		hidden,
		store,
		env,
		context,
		grant,
	}
}

test('file collaborator lists use the same team, member, and outside subject model as packages', async () => {
	const f = await fixture()
	try {
		const team = await createTeam({
			db: f.db,
			orgId: f.owner,
			slug: 'writers',
			name: 'Writers',
			createdByUserId: f.owner,
			audit: f.audit,
		})
		const outside = 'c'.repeat(64)
		insertTestUser(f.sqlite, {
			id: 3,
			username: 'outside-reader',
			stableUserId: outside,
		})
		for (const subject of [
			{ type: 'team' as const, id: team.id },
			{ type: 'user' as const, id: outside },
		])
			await upsertGrant({
				db: f.db,
				orgId: f.owner,
				resourceType: 'file',
				resourceId: f.file.id,
				subject,
				preset: 'read',
				permissions: null,
				createdByUserId: f.owner,
				audit: f.audit,
			})
		const result = await listResourceCollaborators({
			db: f.db,
			orgId: f.owner,
			resourceType: 'file',
			resourceId: f.file.id,
		})
		expect(
			result.collaborators.map((person) => [person.kind, person.label]),
		).toEqual([
			['team', 'Writers'],
			['outside', '@outside-reader'],
		])
		expect(result.options.teams).toEqual([])
		expect(result.options.members.map((person) => person.userId)).toEqual([
			f.reader,
		])
	} finally {
		f.sqlite.close()
	}
})

test('grant management cannot bypass a restricted ancestor through a direct child grant', async () => {
	const f = await fixture()
	try {
		const parent = { ...f.hidden, accessMode: 'restricted' as const }
		const child = { ...f.file, parentId: parent.id }
		f.store.metadata.mockImplementation(async (_owner, id) =>
			id === parent.id ? parent : child,
		)
		await f.grant('file', parent.id, ['file:read'])
		await f.grant('file', child.id, ['file:read', 'file:manage_access'])
		await expect(
			authorizeGrantTarget(f.context(), 'file', child.id),
		).rejects.toThrow('access management')
		await f.grant('file', parent.id, ['file:read', 'file:manage_access'])
		await expect(
			authorizeGrantTarget(f.context(), 'file', child.id),
		).resolves.toMatchObject({ family: 'file' })
	} finally {
		f.sqlite.close()
	}
})

test('file reads are filtered, and a read grant never permits writing or deleting', async () => {
	const f = await fixture()
	expect((await listFiles(f.context())).files).toEqual([])
	await expect(getFile(f.context(), f.file.id)).rejects.toThrow()
	expect(f.store.read).not.toHaveBeenCalled()
	await f.grant('file', f.file.id, ['file:read'])
	expect((await listFiles(f.context())).files.map((file) => file.id)).toEqual([
		f.file.id,
	])
	expect(await getFile(f.context(), f.file.id)).toMatchObject({
		file: { content: 'private text' },
		access: { write: false, delete: false },
	})
	await expect(
		writeFile(f.context(), {
			file_id: f.file.id,
			write_id: crypto.randomUUID(),
			base_revision_id: f.file.revisionId,
			content: 'unauthorized',
		}),
	).rejects.toThrow()
	await expect(deleteFile(f.context(), f.file.id)).rejects.toThrow()
	for (const action of ['rename', 'move', 'trash', 'restore'] as const) {
		await expect(
			manageFile(f.context(), {
				file_id: f.file.id,
				operation_id: crypto.randomUUID(),
				expected_version: 0,
				action,
				name: 'No access',
				parent_id: null,
			}),
		).rejects.toThrow()
	}
	await expect(
		patchPage(f.context(), {
			file_id: f.file.id,
			write_id: crypto.randomUUID(),
			base_revision_id: f.file.revisionId,
			operations: [{ kind: 'remove', block_id: crypto.randomUUID() }],
		}),
	).rejects.toThrow()
	expect(f.store.write).not.toHaveBeenCalled()
	expect(f.store.remove).not.toHaveBeenCalled()
	f.sqlite.close()
})

test('a member with explicit create permission receives access only to their new file', async () => {
	const f = await fixture()
	await f.grant('org', f.owner, ['file:create'])
	const id = crypto.randomUUID()
	await writeFile(f.context(), {
		file_id: id,
		write_id: crypto.randomUUID(),
		name: 'Mine.md',
		media_type: 'text/markdown',
		content: 'hello',
	})
	const grants = f.sqlite
		.prepare(
			"SELECT resource_id FROM grants WHERE subject_id = ? AND resource_type = 'file' AND deleted_at IS NULL",
		)
		.all(f.reader)
	expect(grants).toEqual([{ resource_id: id }])
	expect(f.store.write).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerId: f.owner,
			actorId: f.reader,
			fileId: id,
			maxBytes: 1048576,
		}),
	)
	await expect(getFile(f.context(), f.hidden.id)).rejects.toThrow()
	f.sqlite.close()
})

test('a scoped profile intersects its owner permissions and stops working after revocation', async () => {
	const f = await fixture()
	const ownerContext = f.context(f.owner, 'owner')
	const caller = {
		env: f.env,
		request: ownerContext.callerContext.request!,
		orgId: f.owner,
		actor: { userId: f.owner, profileId: null, isOwner: true },
		holds: () => true,
	}
	const profile = await createProfile(caller, {
		name: 'file-reviewer',
		grants: [
			{
				resourceType: 'file',
				resourceId: f.file.id,
				permissions: ['file:read'],
			},
		],
	})
	const scoped = () => ({
		env: f.env,
		callerContext: createMcpCallerContext({
			baseUrl: 'http://localhost',
			source: { kind: 'session' },
			user: ownerContext.callerContext.user,
			orgBinding: {
				org: { id: ownerIdFromStored(f.owner), slug: 'file-owner' },
				role: 'owner',
			},
			profileId: profile.id,
		}),
	})
	expect((await listFiles(scoped())).files.map((file) => file.id)).toEqual([
		f.file.id,
	])
	await expect(
		writeFile(scoped(), {
			file_id: f.file.id,
			write_id: crypto.randomUUID(),
			base_revision_id: f.file.revisionId,
			content: 'no access',
		}),
	).rejects.toThrow()
	expect(f.store.write).not.toHaveBeenCalled()
	await revokeProfile(caller, { profileId: profile.id })
	await expect(getFile(scoped(), f.file.id)).rejects.toThrow()
	f.sqlite.close()
})

test('retrying a profile create does not restore a revoked file grant', async () => {
	const f = await fixture()
	const ownerContext = f.context(f.owner, 'owner')
	const caller = {
		env: f.env,
		request: ownerContext.callerContext.request!,
		orgId: f.owner,
		actor: { userId: f.owner, profileId: null, isOwner: true },
		holds: () => true,
	}
	const profile = await createProfile(caller, {
		name: 'file-creator',
		grants: [
			{
				resourceType: 'org',
				resourceId: f.owner,
				permissions: ['file:create'],
			},
		],
	})
	const scoped = () => ({
		env: f.env,
		callerContext: createMcpCallerContext({
			baseUrl: 'http://localhost',
			source: { kind: 'session' },
			user: ownerContext.callerContext.user,
			orgBinding: {
				org: { id: ownerIdFromStored(f.owner), slug: 'file-owner' },
				role: 'owner',
			},
			profileId: profile.id,
		}),
	})
	const input = {
		file_id: crypto.randomUUID(),
		write_id: crypto.randomUUID(),
		name: 'Created.md',
		media_type: 'text/markdown' as const,
		content: 'hello',
	}
	await writeFile(scoped(), input)
	const grant = f.sqlite
		.prepare(
			'SELECT id FROM grants WHERE subject_id = ? AND resource_id = ? AND deleted_at IS NULL',
		)
		.get(profile.id, input.file_id) as { id: string }
	expect(grant).toBeTruthy()
	await softDeleteGrant({
		db: f.db,
		orgId: f.owner,
		grantId: grant.id,
		audit: createTestOrgAuditWriter({
			appDb: f.db,
			db: f.env.AUDIT_DB,
			actorUserId: f.owner,
		}),
	})
	await writeFile(scoped(), input)
	expect(
		f.sqlite
			.prepare(
				'SELECT COUNT(*) AS n FROM grants WHERE subject_id = ? AND resource_id = ? AND deleted_at IS NULL',
			)
			.get(profile.id, input.file_id),
	).toEqual({ n: 0 })
	await expect(getFile(scoped(), input.file_id)).rejects.toThrow()
	f.sqlite.close()
})

test('a file invitation is visible only to its recipient and accepts into file access', async () => {
	const f = await fixture()
	const created = await inviteCreateCapability.handler(
		{
			kind: 'grant',
			resource_type: 'file',
			resource_id: f.file.id,
			email: 'file-reader@example.com',
			preset: 'read',
		},
		f.context(f.owner, 'owner'),
	)
	f.store.metadata.mockClear()
	expect(
		(await fileInvitationOffer(f.context(f.owner, 'owner'), created.token)).ok,
	).toBe(false)
	expect(f.store.metadata).not.toHaveBeenCalled()
	const offer = await fileInvitationOffer(f.context(), created.token)
	expect(offer).toMatchObject({ ok: true, name: f.file.name, accepted: false })
	await acceptFileInvitation(f.context(), created.token)
	expect(await getFile(f.context(), f.file.id)).toMatchObject({
		access: { write: false, delete: false },
	})
	expect(await fileInvitationOffer(f.context(), created.token)).toMatchObject({
		ok: true,
		accepted: true,
	})
	f.sqlite.close()
})

test('preview descriptors enforce grants without loading file contents', async () => {
	const f = await fixture()
	await expect(getFileDescriptor(f.context(), f.file.id)).rejects.toThrow()
	expect(f.store.metadata).not.toHaveBeenCalled()
	await f.grant('file', f.file.id, ['file:read'])
	expect(await getFileDescriptor(f.context(), f.file.id)).toMatchObject({
		file: { id: f.file.id, content: '' },
		access: { write: false, delete: false },
	})
	expect(f.store.read).not.toHaveBeenCalled()
	await expect(
		getFileDescriptor(f.context(), f.file.id, crypto.randomUUID()),
	).rejects.toThrow('File revision not found')
})

test('private range reads authorize once, use the owning namespace, and do not decode file bodies', async () => {
	const f = await fixture()
	f.file.revisions.push({
		id: f.file.revisionId,
		bytes: 100,
		sha256: 'hash',
		createdAt: 'now',
		author: 'Owner',
	})
	const read = vi.fn(async () => ({ body: new Response('0123456789').body }))
	Object.assign(f.env, { FILE_BLOBS: { get: read } })
	await expect(
		getFileAsset(f.context(), f.file.id, undefined, 'bytes=10-19'),
	).rejects.toThrow()
	expect(read).not.toHaveBeenCalled()
	await f.grant('file', f.file.id, ['file:read'])
	f.store.metadata.mockClear()
	const asset = await getFileAsset(
		f.context(),
		f.file.id,
		undefined,
		'bytes=10-19',
	)
	expect(asset.range).toEqual({ offset: 10, length: 10 })
	expect(read).toHaveBeenCalledWith(
		`files:v1/${f.owner}/${f.file.id}/${f.file.revisionId}`,
		{ range: { offset: 10, length: 10 } },
	)
	expect(f.store.metadata).toHaveBeenCalledTimes(1)
	expect(f.store.read).not.toHaveBeenCalled()
	read.mockClear()
	const head = await getFileAsset(f.context(), f.file.id, undefined, null, true)
	expect(head.object).toBeNull()
	expect(read).not.toHaveBeenCalled()
	const invalid = await getFileAsset(
		f.context(),
		f.file.id,
		undefined,
		'bytes=100-',
	)
	expect(invalid.range).toBe(false)
	expect(read).not.toHaveBeenCalled()
})
