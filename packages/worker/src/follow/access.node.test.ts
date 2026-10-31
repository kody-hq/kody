import { permissionsForGrantPreset } from '@kody-internal/shared/grant-presets.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { resourceGrantKey } from '#worker/authorization/access-compile.ts'
import { type EffectivePermissions } from '#worker/authorization/authorize.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	followAccessFromPermissions,
	loadFollowTargetSnapshot,
} from './access.ts'

const ownerId = ownerIdFromStored('org-owner')
const packageId = 'pkg-1'

function accessWith(
	permissions: ReadonlyArray<OrgPermission>,
): EffectivePermissions {
	return {
		orgId: ownerId,
		permissions: new Set(),
		isOwner: false,
		resourcePermissions: new Map([
			[resourceGrantKey('package', packageId), new Set(permissions)],
		]),
		credentialScopes: null,
	}
}

test('a use grant can follow and receive push; execute-only cannot', () => {
	const use = followAccessFromPermissions({
		targetKind: 'package',
		isPrivate: true,
		access: accessWith(permissionsForGrantPreset('package', 'use')),
		packageId,
		ownerId,
	})
	expect(use).toEqual({ canCreate: true, canPush: true })

	const executeOnly = followAccessFromPermissions({
		targetKind: 'package',
		isPrivate: true,
		access: accessWith(['package:execute']),
		packageId,
		ownerId,
	})
	expect(executeOnly).toEqual({ canCreate: false, canPush: false })

	const publicExecuteOnly = followAccessFromPermissions({
		targetKind: 'package',
		isPrivate: false,
		access: accessWith(['package:execute']),
		packageId,
		ownerId,
	})
	expect(publicExecuteOnly).toEqual({ canCreate: true, canPush: false })
})

test('a plain repo push requires org-wide package:read, not a single package grant', () => {
	const packageGrant = followAccessFromPermissions({
		targetKind: 'repo',
		isPrivate: false,
		access: accessWith(permissionsForGrantPreset('package', 'use')),
		packageId: null,
		ownerId,
	})
	expect(packageGrant).toEqual({ canCreate: true, canPush: false })

	const orgWide = followAccessFromPermissions({
		targetKind: 'repo',
		isPrivate: true,
		access: {
			orgId: ownerId,
			permissions: new Set(['package:read']),
			isOwner: false,
			resourcePermissions: new Map(),
			credentialScopes: null,
		},
		packageId: null,
		ownerId,
	})
	expect(orgWide).toEqual({ canCreate: true, canPush: true })
})

function targetDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE saved_packages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			description TEXT NOT NULL,
			tags_json TEXT NOT NULL DEFAULT '[]',
			search_text TEXT,
			source_id TEXT NOT NULL,
			has_app INTEGER NOT NULL DEFAULT 0,
			has_skills INTEGER NOT NULL DEFAULT 0,
			hidden INTEGER NOT NULL DEFAULT 0,
			is_private INTEGER NOT NULL DEFAULT 1,
			is_internet_visible INTEGER NOT NULL DEFAULT 0,
			locked_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			deleted_at TEXT
		);
		CREATE TABLE user_repos (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT,
			is_private INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			deleted_at TEXT
		);
		CREATE TABLE orgs (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			display_name TEXT,
			avatar_key TEXT,
			plan TEXT NOT NULL DEFAULT 'free',
			entitlement_ladder TEXT NOT NULL DEFAULT 'free',
			deleted_at TEXT
		);
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('a transferred target loads by id under the live owner and name', async () => {
	const { sqlite, db } = targetDb()
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, plan, entitlement_ladder) VALUES (?, ?, 'free', 'free')`,
		)
		.run('org-dest', 'dest')
	sqlite
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id, is_private, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'desc', 'src-1', 0, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`,
		)
		.run('pkg-1', 'org-dest', '@dest/notes', 'notes')
	sqlite
		.prepare(
			`INSERT INTO user_repos (
				id, user_id, name, is_private, created_at, updated_at
			) VALUES (?, ?, ?, 1, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`,
		)
		.run('repo-1', 'org-dest', 'notes')

	const stored = {
		targetOwnerId: 'org-source',
		targetId: 'pkg-1',
		targetName: '@source/notes',
	}
	expect(
		await loadFollowTargetSnapshot(db, { ...stored, targetKind: 'package' }),
	).toEqual({
		kind: 'package',
		ownerId: 'org-dest',
		id: 'pkg-1',
		name: '@dest/notes',
		isPrivate: false,
	})
	expect(
		await loadFollowTargetSnapshot(db, {
			targetKind: 'repo',
			targetOwnerId: 'org-source',
			targetId: 'repo-1',
			targetName: '@source/notes',
		}),
	).toEqual({
		kind: 'repo',
		ownerId: 'org-dest',
		id: 'repo-1',
		name: '@dest/notes',
		isPrivate: true,
	})

	sqlite
		.prepare(`UPDATE saved_packages SET deleted_at = ? WHERE id = ?`)
		.run('2026-10-15T01:00:00.000Z', 'pkg-1')
	expect(
		await loadFollowTargetSnapshot(db, { ...stored, targetKind: 'package' }),
	).toBeNull()
})
