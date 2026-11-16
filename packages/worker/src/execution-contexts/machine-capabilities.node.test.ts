import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	listMachineDefinedCapabilities,
	parseMachineDefinedCapabilities,
	syncMachineDefinedCapabilities,
	type MachineDefinedCapability,
} from './machine-capabilities.ts'

const context = {
	id: 'ec_vault',
	org_id: 'org_kent',
	operator_user_id: 'user_kent',
}

const kdocker: MachineDefinedCapability = {
	kind: 'command',
	name: 'kdocker',
	description: 'Docker helper',
	summary: { args: [['ps']], background: false, timeoutMs: 60_000 },
}
const nas: MachineDefinedCapability = {
	kind: 'lan',
	name: 'nas-admin',
	description: '',
	summary: { hosts: ['192.168.1.10'], ports: [5001] },
}

function setup() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite.exec(`
		INSERT INTO machine_capabilities (
			id, context_id, org_id, operator_user_id, kind, name, created_at, updated_at
		) VALUES ('mcap_shell', 'ec_vault', 'org_kent', 'user_kent', 'shell', 'shell', '2026-11-15', '2026-11-15');
	`)
	const epoch = (orgId: string) =>
		(
			sqlite
				.prepare(`SELECT access_epoch FROM orgs WHERE id = ?`)
				.get(orgId) as { access_epoch: number } | undefined
		)?.access_epoch
	const grant = (capabilityId: string, orgId: string) =>
		sqlite
			.prepare(
				`INSERT INTO grants (
					id, org_id, resource_type, resource_id, subject_type, subject_id,
					preset, created_by_user_id, created_at, updated_at
				) VALUES (?, ?, 'machine_capability', ?, 'user', 'user_cole', 'use', 'user_kent', '2026-11-15', '2026-11-15')`,
			)
			.run(`grant_${capabilityId}`, orgId, capabilityId)
	const liveGrants = () =>
		sqlite
			.prepare(
				`SELECT resource_id FROM grants WHERE resource_type = 'machine_capability' AND deleted_at IS NULL ORDER BY resource_id`,
			)
			.all()
			.map((row) => (row as { resource_id: string }).resource_id)
	return { sqlite, db: createD1FromSqlite(sqlite), epoch, grant, liveGrants }
}

test('a machine report adds, changes and removes named capabilities and leaves the shell row alone', async () => {
	const { sqlite, db, grant, liveGrants } = setup()
	expect(
		await syncMachineDefinedCapabilities(db, context, [kdocker, nas]),
	).toEqual({
		added: ['command:kdocker', 'lan:nas-admin'],
		changed: [],
		removed: [],
	})
	const [command, lan] = await listMachineDefinedCapabilities(db, 'ec_vault')
	expect(command).toMatchObject({
		kind: 'command',
		name: 'kdocker',
		org_id: 'org_kent',
		operator_user_id: 'user_kent',
		allowed_packages_json: '[]',
	})
	expect(JSON.parse(command!.summary_json)).toEqual(kdocker.summary)

	grant(command!.id, 'org_kent')
	grant(lan!.id, 'org_kent')
	grant('mcap_shell', 'org_kent')
	sqlite
		.prepare(
			`UPDATE machine_capabilities SET allowed_packages_json = ? WHERE id = ?`,
		)
		.run('["pkg_1"]', lan!.id)

	const wider = {
		...kdocker,
		summary: { ...kdocker.summary, args: [['ps'], ['projects']] },
	}
	expect(await syncMachineDefinedCapabilities(db, context, [wider])).toEqual({
		added: [],
		changed: ['command:kdocker'],
		removed: ['lan:nas-admin'],
	})
	// The changed capability keeps its id and grant; the removed one loses both.
	expect(liveGrants()).toEqual([command!.id, 'mcap_shell'].sort())
	expect(
		(await listMachineDefinedCapabilities(db, 'ec_vault')).map((row) => row.id),
	).toEqual([command!.id])

	// Defining the same name again starts with nobody and no packages allowed.
	expect(
		await syncMachineDefinedCapabilities(db, context, [wider, nas]),
	).toMatchObject({ added: ['lan:nas-admin'] })
	const revived = (await listMachineDefinedCapabilities(db, 'ec_vault'))[1]
	expect(revived).toMatchObject({
		id: lan!.id,
		allowed_packages_json: '[]',
		removed_at: null,
	})
	expect(liveGrants()).not.toContain(lan!.id)
})

test('removing a granted capability bumps the access epoch of the org that held the grant', async () => {
	const { sqlite, db, epoch, grant } = setup()
	sqlite.exec(
		`INSERT INTO orgs (id, slug, access_epoch, created_at, updated_at)
		 VALUES ('org_kent', 'kent', 1, '2026-11-15', '2026-11-15')`,
	)
	await syncMachineDefinedCapabilities(db, context, [kdocker])
	const [command] = await listMachineDefinedCapabilities(db, 'ec_vault')
	grant(command!.id, 'org_kent')
	const before = epoch('org_kent')!
	expect(await syncMachineDefinedCapabilities(db, context, [kdocker])).toEqual({
		added: [],
		changed: [],
		removed: [],
	})
	expect(epoch('org_kent')).toBe(before)
	await syncMachineDefinedCapabilities(db, context, [])
	expect(epoch('org_kent')).toBe(before + 1)
})

test.each([
	['not a list', {}, /must be a list/],
	['shell', [{ kind: 'shell', name: 'shell' }], /"command" or "lan"/],
	['fs', [{ kind: 'fs', name: 'docs' }], /"command" or "lan"/],
	['bad name', [{ kind: 'command', name: 'Bad Name' }], /must be lowercase/],
	[
		'duplicate',
		[
			{ kind: 'lan', name: 'nas' },
			{ kind: 'lan', name: 'nas' },
		],
		/listed twice/,
	],
	[
		'huge summary',
		[{ kind: 'lan', name: 'nas', summary: { hosts: 'x'.repeat(5000) } }],
		/at most 4096 characters/,
	],
	[
		'too many',
		Array.from({ length: 101 }, (_, index) => ({
			kind: 'lan',
			name: `nas-${index}`,
		})),
		/at most 100/,
	],
])('a machine report with %s is refused', (_label, value, message) => {
	expect(parseMachineDefinedCapabilities(value)).toMatch(message)
})
