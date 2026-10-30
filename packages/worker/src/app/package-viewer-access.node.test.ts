import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { runWithRequestContext } from '#worker/request-context.ts'
import {
	viewerCanDeleteSavedPackage,
	viewerCanExecutePackageApp,
	viewerCanManageSavedPackage,
	viewerCanManageSavedPackageAccess,
	viewerCanPublishSavedPackage,
	viewerIsSavedPackageOrgOwner,
} from './package-viewer-access.ts'

const ownerId = personIdFromStored('person-owner')
const memberId = personIdFromStored('person-member')
const ungrantedId = personIdFromStored('person-ungranted')
const outsiderId = personIdFromStored('person-outsider')
const teamId = ownerIdFromStored('org-acme')
const now = '2026-01-01T00:00:00.000Z'

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const insertOrg = sqlite.prepare(
		`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
	)
	const insertMembership = sqlite.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES (?, ?, ?, ?)`,
	)
	insertOrg.run(teamId, 'acme', 'Acme', now, now)
	sqlite
		.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES (?, ?, ?)`,
		)
		.run('acme', teamId, now)
	for (const [id, slug] of [
		[ownerId, 'owner'],
		[memberId, 'member'],
		[ungrantedId, 'ungranted'],
		[outsiderId, 'outsider'],
	] as const) {
		insertOrg.run(id, slug, slug, now, now)
		insertMembership.run(id, id, 'owner', now)
	}
	insertMembership.run(teamId, ownerId, 'owner', now)
	insertMembership.run(teamId, memberId, 'member', now)
	insertMembership.run(teamId, ungrantedId, 'member', now)
	sqlite
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at, deleted_at
			) VALUES (?, ?, 'org', ?, 'user', ?, 'use', ?, ?, ?, NULL)`,
		)
		.run('grant-app', teamId, teamId, memberId, ownerId, now, now)
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
		)
		.run('grant-app', 'app:execute')
	return { APP_DB: createD1FromSqlite(sqlite) } as unknown as Env
}

function viewer(personId: ReturnType<typeof personIdFromStored>) {
	return { userId: personId, username: String(personId) }
}

test('viewerCanExecutePackageApp refuses outsiders, anonymous visitors, and members without app:execute', async () => {
	const env = createEnv()

	await expect(
		viewerCanExecutePackageApp({
			env,
			viewer: viewer(ungrantedId),
			ownerId: teamId,
		}),
	).resolves.toBe(false)
	await expect(
		viewerCanExecutePackageApp({
			env,
			viewer: viewer(outsiderId),
			ownerId: teamId,
		}),
	).resolves.toBe(false)
	await expect(
		viewerCanExecutePackageApp({
			env,
			viewer: null,
			ownerId: teamId,
		}),
	).resolves.toBe(false)
})

test('viewerCanExecutePackageApp scopes app:execute to the requested app resource', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const insertOrg = sqlite.prepare(
		`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
	)
	const insertMembership = sqlite.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES (?, ?, ?, ?)`,
	)
	insertOrg.run(teamId, 'acme', 'Acme', now, now)
	sqlite
		.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES (?, ?, ?)`,
		)
		.run('acme', teamId, now)
	for (const [id, slug] of [
		[ownerId, 'owner'],
		[memberId, 'member'],
	] as const) {
		insertOrg.run(id, slug, slug, now, now)
		insertMembership.run(id, id, 'owner', now)
	}
	insertMembership.run(teamId, ownerId, 'owner', now)
	insertMembership.run(teamId, memberId, 'member', now)
	sqlite
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at, deleted_at
			) VALUES (?, ?, 'app', ?, 'user', ?, 'use', ?, ?, ?, NULL)`,
		)
		.run('grant-app-a', teamId, 'app-a', memberId, ownerId, now, now)
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
		)
		.run('grant-app-a', 'app:execute')
	const env = { APP_DB: createD1FromSqlite(sqlite) } as unknown as Env

	await expect(
		viewerCanExecutePackageApp({
			env,
			viewer: viewer(memberId),
			ownerId: teamId,
			appId: 'app-a',
		}),
	).resolves.toBe(true)
	await expect(
		viewerCanExecutePackageApp({
			env,
			viewer: viewer(memberId),
			ownerId: teamId,
			appId: 'app-b',
		}),
	).resolves.toBe(false)
})

function countAccessReads(env: Env) {
	const db = env.APP_DB
	const counts = { epoch: 0, cache: 0 }
	const prepare = db.prepare.bind(db)
	db.prepare = (sql: string) => {
		if (/SELECT access_epoch FROM orgs/.test(sql)) counts.epoch += 1
		if (/FROM access_cache/.test(sql)) counts.cache += 1
		return prepare(sql)
	}
	return counts
}

test('the package page viewer checks compile access once per request', async () => {
	const env = createEnv()
	const counts = countAccessReads(env)
	const input = {
		env,
		viewer: viewer(memberId),
		ownerId: teamId,
		packageId: 'pkg-1',
	}
	const checks = () =>
		Promise.all([
			viewerCanManageSavedPackage(input),
			viewerCanPublishSavedPackage(input),
			viewerCanDeleteSavedPackage(input),
			viewerCanManageSavedPackageAccess(input),
			viewerIsSavedPackageOrgOwner(input),
			viewerCanExecutePackageApp({ ...input, appId: input.packageId }),
		])

	const results = await runWithRequestContext(
		new Request('https://kody.test/acme/pkg'),
		checks,
	)
	expect(results).toEqual([false, false, false, false, false, true])
	expect(counts).toEqual({ epoch: 1, cache: 1 })

	// A new request re-reads the epoch, so a bump is never hidden across requests.
	await runWithRequestContext(new Request('https://kody.test/acme/pkg'), checks)
	expect(counts).toEqual({ epoch: 2, cache: 2 })
})
