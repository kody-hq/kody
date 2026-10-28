import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { packageSettingsAuditDetails } from './package-audit.ts'
import { insertSavedPackage, updateSavedPackage } from './repo.ts'

test('packageSettingsAuditDetails keeps before and after only for visibility', () => {
	const before = {
		name: '@acme/tool',
		is_private: 1,
		is_internet_visible: 0,
		hidden: 0,
	}
	expect(packageSettingsAuditDetails(before, { isPrivate: true })).toBeNull()
	expect(
		packageSettingsAuditDetails(before, {
			isPrivate: false,
			isInternetVisible: true,
			hidden: true,
		}),
	).toEqual({
		visibility: { before: 'private', after: 'public' },
		internetVisible: { before: false, after: true },
		fields: ['visibility', 'internet_visible', 'hidden'],
	})
})

test('updateSavedPackage audits a real visibility change once, and metadata edits not at all', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const audit = createTestOrgAuditWriter({ appDb: db, actorUserId: 'person-1' })
	const userId = ownerIdFromStored('acme-org')
	const packageId = crypto.randomUUID()
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: userId,
			name: '@acme/tool',
			description: 'Team tool',
			tags_json: '[]',
			search_text: null,
			source_id: crypto.randomUUID(),
			has_app: 0,
			has_skills: 0,
			hidden: 0,
			is_private: 1,
		},
		null,
		{ stamp: false },
	)
	await updateSavedPackage(db, {
		userId,
		packageId,
		description: 'New words',
		audit,
	})
	await updateSavedPackage(db, { userId, packageId, isPrivate: false, audit })
	// Already public: no change, no row.
	await updateSavedPackage(db, { userId, packageId, isPrivate: false, audit })
	const { results } = await audit.db
		.prepare(
			`SELECT action, resource_type, resource_id, details_json FROM org_audit_events`,
		)
		.all<{
			action: string
			resource_type: string
			resource_id: string
			details_json: string
		}>()
	expect(results).toHaveLength(1)
	expect(results[0]).toMatchObject({
		action: 'package.updated',
		resource_type: 'package',
		resource_id: packageId,
	})
	expect(JSON.parse(results[0]!.details_json)).toEqual({
		name: '@acme/tool',
		visibility: { before: 'private', after: 'public' },
		fields: ['visibility'],
	})
})
