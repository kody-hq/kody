/**
 * Batched {@link loadContextsAccess} must match per-row {@link loadContextAccess}
 * and keep attachment/grant lookups O(chunks) under D1's bind cap (Sentry KODY-E6).
 */
import { maxD1BoundParameters } from '@kody-internal/shared/chunk.ts'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	collaboratorPeople,
	collaboratorsNow,
	type PackageCollaboratorsSeed,
	seedPackageCollaborators,
} from '#worker/test-support/package-collaborators-seed.ts'
import {
	type ExecutionContextRow,
	loadContextAccess,
	loadContextsAccess,
} from './store.ts'

async function seedWithContextTables() {
	const seed = await seedPackageCollaborators()
	seed.sqlite.exec(`
		CREATE TABLE execution_context_org_attachments (
			context_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			attached_by_user_id TEXT NOT NULL,
			all_members INTEGER NOT NULL DEFAULT 0,
			narrowing_json TEXT,
			created_at TEXT NOT NULL,
			PRIMARY KEY (context_id, org_id)
		);
		CREATE TABLE execution_context_opt_ins (
			context_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (context_id, user_id, org_id)
		);
	`)
	return seed
}

function contextRow(
	seed: PackageCollaboratorsSeed,
	overrides: Partial<ExecutionContextRow> & { id: string },
): ExecutionContextRow {
	return {
		org_id: seed.orgId,
		operator_user_id: collaboratorPeople.ada.personId,
		all_members: 0,
		name: overrides.id,
		public_key_jwk: '{}',
		thumbprint: `thumb-${overrides.id}`,
		created_at: collaboratorsNow,
		revoked_at: null,
		revoked_reason: null,
		last_seen_at: null,
		client_name: null,
		client_version: null,
		capabilities_json: null,
		grant_json: null,
		grant_version: 1,
		...overrides,
	}
}

function insertGrant(
	seed: PackageCollaboratorsSeed,
	input: {
		id: string
		resourceId: string
		subjectType: string
		subjectId: string
		preset: string
	},
) {
	seed.sqlite
		.prepare(
			`INSERT INTO grants (
			   id, org_id, resource_type, resource_id, subject_type, subject_id,
			   preset, created_by_user_id, created_at, updated_at
			 ) VALUES (?, ?, 'execution_context', ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			seed.orgId,
			input.resourceId,
			input.subjectType,
			input.subjectId,
			input.preset,
			collaboratorPeople.ada.personId,
			collaboratorsNow,
			collaboratorsNow,
		)
}

function insertAttachment(
	seed: PackageCollaboratorsSeed,
	input: { contextId: string; allMembers: number },
) {
	seed.sqlite
		.prepare(
			`INSERT INTO execution_context_org_attachments
			 (context_id, org_id, attached_by_user_id, all_members, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.run(
			input.contextId,
			seed.orgId,
			collaboratorPeople.ada.personId,
			input.allMembers,
			collaboratorsNow,
		)
}

function insertOptIn(
	seed: PackageCollaboratorsSeed,
	input: { contextId: string; userId: string },
) {
	seed.sqlite
		.prepare(
			`INSERT INTO execution_context_opt_ins (context_id, user_id, org_id, created_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(input.contextId, input.userId, seed.orgId, collaboratorsNow)
}

function normalizeSql(query: string) {
	return query.replace(/\s+/g, ' ').trim().toLowerCase()
}

function isAttachmentLookup(query: string) {
	const sql = normalizeSql(query)
	return (
		sql.includes('from execution_context_org_attachments') &&
		sql.includes('context_id')
	)
}

function isGrantPresetLookup(query: string) {
	const sql = normalizeSql(query)
	return (
		sql.includes('from grants g') &&
		sql.includes("g.resource_type = 'execution_context'") &&
		sql.includes('g.preset')
	)
}

async function accessBySingle(
	db: D1Database,
	contexts: ReadonlyArray<ExecutionContextRow>,
	input: { userId: string; orgId: string },
) {
	const map = new Map<string, Awaited<ReturnType<typeof loadContextAccess>>>()
	for (const context of contexts) {
		map.set(context.id, await loadContextAccess(db, context, input))
	}
	return map
}

test('loadContextsAccess matches N× loadContextAccess across fixture combinations', async () => {
	const seed = await seedWithContextTables()
	const foreignOrg = 'other-org-not-attached'
	const contexts = [
		contextRow(seed, { id: 'ctx-operator' }),
		contextRow(seed, {
			id: 'ctx-all-members',
			org_id: foreignOrg,
			all_members: 0,
		}),
		contextRow(seed, { id: 'ctx-user-grant' }),
		contextRow(seed, { id: 'ctx-team-grant' }),
		contextRow(seed, { id: 'ctx-not-attached', org_id: foreignOrg }),
		contextRow(seed, {
			id: 'ctx-revoked',
			revoked_at: collaboratorsNow,
		}),
		contextRow(seed, {
			id: 'ctx-operator-left',
			operator_user_id: collaboratorPeople.erin.personId,
		}),
		contextRow(seed, { id: 'ctx-opted-in' }),
		contextRow(seed, { id: 'ctx-not-opted-in' }),
	]
	insertAttachment(seed, { contextId: 'ctx-all-members', allMembers: 1 })
	insertGrant(seed, {
		id: 'grant-user',
		resourceId: 'ctx-user-grant',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'contribute',
	})
	insertGrant(seed, {
		id: 'grant-team',
		resourceId: 'ctx-team-grant',
		subjectType: 'team',
		subjectId: 'team-design',
		preset: 'use',
	})
	insertGrant(seed, {
		id: 'grant-opted',
		resourceId: 'ctx-opted-in',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'use',
	})
	insertGrant(seed, {
		id: 'grant-not-opted',
		resourceId: 'ctx-not-opted-in',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'use',
	})
	insertGrant(seed, {
		id: 'grant-operator-left',
		resourceId: 'ctx-operator-left',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'use',
	})
	insertOptIn(seed, {
		contextId: 'ctx-opted-in',
		userId: collaboratorPeople.bob.personId,
	})
	insertOptIn(seed, {
		contextId: 'ctx-user-grant',
		userId: collaboratorPeople.bob.personId,
	})
	insertOptIn(seed, {
		contextId: 'ctx-team-grant',
		userId: collaboratorPeople.bob.personId,
	})
	insertOptIn(seed, {
		contextId: 'ctx-all-members',
		userId: collaboratorPeople.bob.personId,
	})
	insertOptIn(seed, {
		contextId: 'ctx-operator-left',
		userId: collaboratorPeople.bob.personId,
	})

	const input = {
		userId: collaboratorPeople.bob.personId,
		orgId: seed.orgId,
	}
	const batched = await loadContextsAccess(seed.db, contexts, input)
	const singles = await accessBySingle(seed.db, contexts, input)

	expect([...batched.keys()].sort()).toEqual([...singles.keys()].sort())
	for (const id of singles.keys()) {
		expect(batched.get(id), id).toEqual(singles.get(id))
	}

	expect(batched.get('ctx-operator')).toMatchObject({
		isOperator: false,
		granted: false,
		unusableReason: 'not_granted',
	})
	expect(batched.get('ctx-all-members')).toMatchObject({
		attached: true,
		granted: true,
		usable: true,
		preset: 'use',
	})
	expect(batched.get('ctx-user-grant')).toMatchObject({
		granted: true,
		preset: 'contribute',
		usable: true,
	})
	expect(batched.get('ctx-team-grant')).toMatchObject({
		granted: true,
		preset: 'use',
		usable: true,
	})
	expect(batched.get('ctx-not-attached')).toMatchObject({
		attached: false,
		unusableReason: 'not_attached',
	})
	expect(batched.get('ctx-revoked')).toMatchObject({
		unusableReason: 'revoked',
	})
	expect(batched.get('ctx-operator-left')).toMatchObject({
		unusableReason: 'operator_left',
	})
	expect(batched.get('ctx-opted-in')).toMatchObject({
		optedIn: true,
		usable: true,
	})
	expect(batched.get('ctx-not-opted-in')).toMatchObject({
		optedIn: false,
		unusableReason: 'not_opted_in',
	})

	const operatorInput = {
		userId: collaboratorPeople.ada.personId,
		orgId: seed.orgId,
	}
	const operatorBatched = await loadContextsAccess(
		seed.db,
		[contexts[0]!],
		operatorInput,
	)
	const operatorSingle = await loadContextAccess(
		seed.db,
		contexts[0]!,
		operatorInput,
	)
	expect(operatorBatched.get('ctx-operator')).toEqual(operatorSingle)
	expect(operatorBatched.get('ctx-operator')).toMatchObject({
		isOperator: true,
		usable: true,
		preset: 'manage',
	})
})

test('loadContextsAccess issues one attachment and one grant query for a small list', async () => {
	const seed = await seedWithContextTables()
	const contexts = Array.from({ length: 9 }, (_, index) =>
		contextRow(seed, { id: `ctx-${index}` }),
	)
	for (const context of contexts) {
		insertGrant(seed, {
			id: `grant-${context.id}`,
			resourceId: context.id,
			subjectType: 'user',
			subjectId: collaboratorPeople.bob.personId,
			preset: 'use',
		})
		insertOptIn(seed, {
			contextId: context.id,
			userId: collaboratorPeople.bob.personId,
		})
	}

	const prepared: Array<string> = []
	const prepare = seed.db.prepare.bind(seed.db)
	vi.spyOn(seed.db, 'prepare').mockImplementation((query: string) => {
		prepared.push(query)
		return prepare(query)
	})

	await loadContextsAccess(seed.db, contexts, {
		userId: collaboratorPeople.bob.personId,
		orgId: seed.orgId,
	})

	expect(prepared.filter(isAttachmentLookup)).toHaveLength(1)
	expect(prepared.filter(isGrantPresetLookup)).toHaveLength(1)
	expect(normalizeSql(prepared.find(isAttachmentLookup)!)).toContain(
		'context_id in (',
	)
	expect(normalizeSql(prepared.find(isGrantPresetLookup)!)).toContain(
		'g.resource_id in (',
	)

	prepared.length = 0
	for (const context of contexts) {
		await loadContextAccess(seed.db, context, {
			userId: collaboratorPeople.bob.personId,
			orgId: seed.orgId,
		})
	}
	expect(prepared.filter(isAttachmentLookup).length).toBe(contexts.length)
	expect(prepared.filter(isGrantPresetLookup).length).toBe(contexts.length)
})

test('loadContextsAccess chunks under the D1 bind limit for large lists', async () => {
	const seed = await seedWithContextTables()
	const db = createD1FromSqlite(seed.sqlite, {
		maxBindings: maxD1BoundParameters,
	})
	// Above the grant-query headroom (~94 ids) so an unchunked IN would fail.
	const contexts = Array.from({ length: 120 }, (_, index) =>
		contextRow(seed, { id: `ctx-big-${index}` }),
	)
	for (const context of contexts) {
		insertGrant(seed, {
			id: `grant-${context.id}`,
			resourceId: context.id,
			subjectType: 'user',
			subjectId: collaboratorPeople.bob.personId,
			preset: 'use',
		})
		insertOptIn(seed, {
			contextId: context.id,
			userId: collaboratorPeople.bob.personId,
		})
	}

	const access = await loadContextsAccess(db, contexts, {
		userId: collaboratorPeople.bob.personId,
		orgId: seed.orgId,
	})
	expect(access.size).toBe(contexts.length)
	expect(access.get('ctx-big-0')).toMatchObject({
		granted: true,
		optedIn: true,
		usable: true,
	})
	expect(access.get('ctx-big-119')).toMatchObject({
		granted: true,
		optedIn: true,
		usable: true,
	})
})

test('loadContextsAccess returns an empty map without querying', async () => {
	const seed = await seedWithContextTables()
	const prepare = vi.spyOn(seed.db, 'prepare')
	const access = await loadContextsAccess(seed.db, [], {
		userId: collaboratorPeople.bob.personId,
		orgId: seed.orgId,
	})
	expect(access.size).toBe(0)
	expect(prepare).not.toHaveBeenCalled()
})
