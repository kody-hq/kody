import { DatabaseSync } from 'node:sqlite'
import { ecpDefaultGrant } from '@kody-internal/shared/execution-context-protocol/index.ts'
import { expect, test, vi } from 'vitest'
import type { EffectivePermissions } from '#worker/authorization/authorize.ts'
import type { ApiInvocationContext } from '#worker/open-api/context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { authorizeContextCommand, authorizeContextLan } from './commands.ts'
import {
	type ExecutionContextCaller,
	setSharing,
	updateContext,
} from './service.ts'
import { getExecutionContext, loadContextAccess, parseGrant } from './store.ts'

const profileAccess = vi.hoisted(() => ({
	current: null as EffectivePermissions | null,
}))

vi.mock('#worker/authorization/authorize.ts', async (original) => ({
	...(await original<object>()),
	computeEffectivePermissions: async () => profileAccess.current,
}))

const orgId = 'org_acme'
const operator = 'user_operator'
const now = '2026-10-30T00:00:00.000Z'

function setup(input: { commands?: boolean } = {}) {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite
		.prepare(
			`INSERT INTO execution_contexts (id, org_id, operator_user_id, all_members, name,
				public_key_jwk, thumbprint, created_at, grant_json, grant_version)
			 VALUES ('ec_mac', ?, ?, 0, 'mac', '{}', 'thumb', ?, ?, 1)`,
		)
		.run(
			orgId,
			operator,
			now,
			JSON.stringify({
				...ecpDefaultGrant,
				...(input.commands
					? { commands: { enabled: true, enabledAt: now } }
					: {}),
			}),
		)
	sqlite.exec(`
		INSERT INTO orgs (id, slug, access_epoch, created_at, updated_at)
			VALUES ('${orgId}', 'acme', 0, '${now}', '${now}');
		INSERT INTO org_memberships (org_id, user_id, role, created_at)
			VALUES ('${orgId}', '${operator}', 'owner', '${now}'),
			       ('${orgId}', 'user_friend', 'member', '${now}'),
			       ('${orgId}', 'user_teammate', 'member', '${now}');
	`)
	const db = createD1FromSqlite(sqlite)
	const audits: Array<Record<string, unknown>> = []
	const grantUpdates: Array<unknown> = []
	const session = {
		updateGrant: async (update: unknown) => {
			grantUpdates.push(update)
		},
		recordAudit: async (entry: Record<string, unknown>) => {
			audits.push(entry)
		},
		getStatus: async () => ({ online: false, acceptingRuns: false }),
		endLeases: async () => {},
	}
	const env = {
		APP_DB: db,
		AUDIT_DB: db,
		EXECUTION_CONTEXT_SESSION: {
			idFromName: (n: string) => n,
			get: () => session,
		},
	} as unknown as Env
	const callerFor = (userId: string) => {
		const request = {
			actor: { userId, username: userId },
			org: { id: orgId, slug: 'acme' },
			membership: { role: 'member' },
			credential: { kind: 'session', id: null },
		}
		return {
			env,
			callerContext: { baseUrl: 'https://kody.test', request },
			request,
			userId,
			orgId,
		} as unknown as ExecutionContextCaller
	}
	const runCtx = (
		userId: string,
		kind = 'execution-context-run',
		scopes: Array<string> | null = null,
		profileId: string | null = null,
		packages?: { entries: Array<string>; all: Array<string> },
	) =>
		({
			env,
			principal: {
				kind,
				ecid: 'ec_mac',
				runId: 'run_1',
				scopes,
				...(packages ? { packages } : {}),
			},
			callerContext: {
				user: { userId, username: userId },
				orgBinding: { org: { id: orgId } },
				...(profileId
					? {
							request: {
								actor: { userId, username: userId },
								org: { id: orgId, slug: 'acme' },
								credential: { kind: 'api-token', id: 'tok_1', profileId },
							},
						}
					: {}),
			},
		}) as unknown as ApiInvocationContext
	const args = {
		commandId: 'cmd_abcdef123',
		command: 'npm run build',
		cwd: '/Users/kent/code/kody',
		envKeys: ['NODE_ENV'],
		background: true,
	}
	return { sqlite, db, env, audits, grantUpdates, callerFor, runCtx, args }
}

test('host commands are off on every new context', async () => {
	const s = setup()
	const row = await getExecutionContext(s.db, 'ec_mac')
	expect(parseGrant(row!).commands?.enabled ?? false).toBe(false)
})

test('a run off a context (cloud or --local) gets a clear context-required error', async () => {
	const s = setup({ commands: true })
	await expect(
		authorizeContextCommand(s.runCtx(operator, 'user'), s.args),
	).rejects.toMatchObject({
		code: 'execution_context_command_requires_context',
	})
})

test('denials name what is missing: machine opt-in off vs the grant', async () => {
	const off = setup()
	await expect(
		authorizeContextCommand(off.runCtx(operator), off.args),
	).rejects.toMatchObject({
		code: 'execution_context_commands_off',
		message: expect.stringMatching(
			/has not opted in.*kody context commands on/s,
		),
	})
	const on = setup({ commands: true })
	await expect(
		authorizeContextCommand(on.runCtx('user_friend'), on.args),
	).rejects.toMatchObject({
		code: 'execution_context_command_not_granted',
		message: expect.stringMatching(/execution_context:command/),
	})
	expect(on.audits).toEqual([])
})

test('the operator may run commands on their own context and each start is audited without env values', async () => {
	const s = setup({ commands: true })
	await expect(
		authorizeContextCommand(s.runCtx(operator), s.args),
	).resolves.toEqual({ ok: true, commandId: 'cmd_abcdef123' })
	expect(s.audits).toEqual([
		expect.objectContaining({
			event: 'command_started',
			actor: { userId: operator, handle: operator },
			orgId,
			detail: {
				commandId: 'cmd_abcdef123',
				runId: 'run_1',
				command: 'npm run build',
				cwd: '/Users/kent/code/kody',
				envKeys: ['NODE_ENV'],
				background: true,
			},
		}),
	])
})

test('command_started names the saved packages Kody served to the run, and nothing for ad hoc code', async () => {
	const s = setup({ commands: true })
	const entries = Array.from({ length: 10 }, (_, i) => `pkg_entry_${i}`)
	await authorizeContextCommand(
		s.runCtx(operator, 'execution-context-run', null, null, {
			entries,
			all: [...entries, 'pkg_dep_a', 'pkg_dep_b'],
		}),
		s.args,
	)
	expect(s.audits[0]?.detail).toMatchObject({
		commandId: 'cmd_abcdef123',
		entryPackageIds: entries.slice(0, 8),
		packageCount: 12,
	})

	const adHoc = setup({ commands: true })
	await authorizeContextCommand(adHoc.runCtx(operator), adHoc.args)
	expect(adHoc.audits[0]?.detail).not.toHaveProperty('entryPackageIds')
	expect(adHoc.audits[0]?.detail).not.toHaveProperty('packageCount')
})

test('host commands are operator-only: shares refuse commands and an older command grant confers nothing', async () => {
	const s = setup({ commands: true })
	const owner = s.callerFor(operator)
	await setSharing(owner, 'ec_mac', {
		add: [{ subject: { type: 'user', id: 'user_friend' }, preset: 'manage' }],
		allMembers: true,
	})
	for (const userId of ['user_friend', 'user_teammate']) {
		await expect(
			authorizeContextCommand(s.runCtx(userId), s.args),
		).rejects.toMatchObject({ code: 'execution_context_command_not_granted' })
	}
	await expect(
		setSharing(owner, 'ec_mac', {
			add: [
				{
					subject: { type: 'user', id: 'user_teammate' },
					preset: 'use',
					commands: true,
				},
			],
		}),
	).rejects.toMatchObject({ code: 'commands_operator_only' })
	// A command share written before the rule stays in place and confers nothing.
	s.sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission)
			 SELECT id, 'execution_context:command' FROM grants WHERE resource_id = 'ec_mac'`,
		)
		.run()
	await expect(
		authorizeContextCommand(s.runCtx('user_friend'), s.args),
	).rejects.toMatchObject({ code: 'execution_context_command_not_granted' })
	await expect(
		authorizeContextCommand(s.runCtx(operator), s.args),
	).resolves.toMatchObject({ ok: true })
})

test('a context fails closed for everyone else once its operator leaves the org', async () => {
	const s = setup()
	await setSharing(s.callerFor(operator), 'ec_mac', {
		add: [{ subject: { type: 'user', id: 'user_friend' }, preset: 'use' }],
	})
	s.sqlite
		.prepare(
			`INSERT INTO execution_context_opt_ins (context_id, user_id, org_id, created_at)
			 VALUES ('ec_mac', 'user_friend', ?, ?)`,
		)
		.run(orgId, now)
	const access = async () =>
		await loadContextAccess(
			s.db,
			(await getExecutionContext(s.db, 'ec_mac'))!,
			{
				userId: 'user_friend',
				orgId,
			},
		)
	expect(await access()).toMatchObject({ usable: true, unusableReason: null })
	s.sqlite
		.prepare(
			`UPDATE org_memberships SET deleted_at = ? WHERE user_id = ? AND org_id = ?`,
		)
		.run(now, operator, orgId)
	expect(await access()).toMatchObject({
		usable: false,
		unusableReason: 'operator_left',
	})
})

test('the website/API can turn commands off but never on', async () => {
	const s = setup()
	const owner = s.callerFor(operator)
	await expect(
		updateContext(owner, 'ec_mac', { grant: { commands: { enabled: true } } }),
	).rejects.toMatchObject({ code: 'commands_opt_in_local' })
	const on = setup({ commands: true })
	await updateContext(on.callerFor(operator), 'ec_mac', {
		grant: { commands: { enabled: false } },
	})
	const row = await getExecutionContext(on.db, 'ec_mac')
	expect(parseGrant(row!).commands).toEqual({ enabled: false, enabledAt: null })
	expect(on.grantUpdates.length).toBe(1)
	expect(on.audits).toContainEqual(
		expect.objectContaining({ event: 'commands_disabled' }),
	)
})

test('fitAuditDetail keeps command_started detail under the audit cut as valid JSON', async () => {
	const { fitAuditDetail } = await import('./commands.ts')
	const fitted = fitAuditDetail({
		commandId: 'cmd_abcdef',
		runId: 'run_1',
		command: '"\\'.repeat(500),
		cwd: '/x'.repeat(256),
		envKeys: Array.from({ length: 64 }, (_, i) => `KEY_${i}_`.padEnd(128, 'K')),
		background: false,
	})
	const json = JSON.stringify(fitted)
	expect(json.length).toBeLessThanOrEqual(2000)
	expect(() => JSON.parse(json.slice(0, 2048))).not.toThrow()
	expect(fitted.truncated).toBe(true)
})

test('a scoped credential without execution_context:command cannot run commands, even for the operator', async () => {
	const s = setup({ commands: true })
	await expect(
		authorizeContextCommand(
			s.runCtx(operator, 'execution-context-run', [
				'org:execute',
				'execution_context:execute',
			]),
			s.args,
		),
	).rejects.toMatchObject({
		code: 'execution_context_command_not_granted',
		message: expect.stringMatching(/token scopes/),
	})
	await expect(
		authorizeContextCommand(
			s.runCtx(operator, 'execution-context-run', [
				'execution_context:execute',
				'execution_context:command',
			]),
			s.args,
		),
	).resolves.toMatchObject({ ok: true })
	expect(s.audits).toHaveLength(1)
})

test('a command cut to the audit cap is marked truncated', async () => {
	const s = setup({ commands: true })
	await authorizeContextCommand(s.runCtx(operator), {
		...s.args,
		command: 'x'.repeat(1500),
	})
	expect(s.audits[0]?.detail).toMatchObject({ truncated: true })
	expect((s.audits[0]?.detail as { command: string }).command).toHaveLength(
		1000,
	)
})

test('lifecycle calls (status, output, kill, list) are authorized without an audit row', async () => {
	const s = setup({ commands: true })
	await expect(
		authorizeContextCommand(s.runCtx(operator), { lifecycle: 'output' }),
	).resolves.toEqual({ ok: true })
	expect(s.audits).toEqual([])
	await expect(
		authorizeContextCommand(s.runCtx('user_friend'), { lifecycle: 'kill' }),
	).rejects.toMatchObject({ code: 'execution_context_command_not_granted' })
	await expect(
		authorizeContextCommand(s.runCtx(operator), { lifecycle: 'spawn' }),
	).rejects.toMatchObject({ code: 'invalid_request' })
	const off = setup()
	await expect(
		authorizeContextCommand(off.runCtx(operator), { lifecycle: 'list' }),
	).rejects.toMatchObject({ code: 'execution_context_commands_off' })
})

test('fitAuditStrings trims command_finished detail to valid JSON under the cut', async () => {
	const { fitAuditStrings } = await import('./audit-detail.ts')
	const fitted = fitAuditStrings(
		{ command: '\u0001'.repeat(500), cwd: '"'.repeat(1024), exitCode: 0 },
		['cwd', 'command'],
	)
	const json = JSON.stringify(fitted)
	expect(json.length).toBeLessThanOrEqual(2000)
	expect(() => JSON.parse(json.slice(0, 2048))).not.toThrow()
	expect(fitted.truncated).toBe(true)
})

test('a run acting as a profile needs execution_context:command granted to every profile layer, even for the operator', async () => {
	const s = setup({ commands: true })
	const layerWith = (permissions: Array<string>): EffectivePermissions =>
		({
			orgId,
			permissions: new Set(['execution_context:command']),
			isOwner: true,
			resourcePermissions: new Map(),
			credentialScopes: null,
			profileChain: {
				inactive: null,
				layers: [
					{
						id: 'prf_bot',
						name: 'bot',
						self: true,
						orgPermissions: new Set(),
						resourcePermissions: new Map([
							['execution_context:ec_mac', new Set(permissions)],
						]),
					},
				],
			},
		}) as unknown as EffectivePermissions
	profileAccess.current = layerWith(['execution_context:execute'])
	await expect(
		authorizeContextCommand(
			s.runCtx(operator, 'execution-context-run', null, 'prf_bot'),
			s.args,
		),
	).rejects.toMatchObject({
		code: 'execution_context_command_not_granted',
		message: expect.stringMatching(/profile/),
	})
	profileAccess.current = layerWith([
		'execution_context:execute',
		'execution_context:command',
	])
	await expect(
		authorizeContextCommand(
			s.runCtx(operator, 'execution-context-run', null, 'prf_bot'),
			s.args,
		),
	).resolves.toMatchObject({ ok: true })
	profileAccess.current = null
})

function defineCommand(
	s: ReturnType<typeof setup>,
	input: { allowedPackages?: Array<string>; removed?: boolean } = {},
) {
	s.sqlite
		.prepare(
			`INSERT INTO machine_capabilities (id, context_id, org_id, operator_user_id, kind, name,
				allowed_packages_json, created_at, updated_at, removed_at)
			 VALUES ('mcap_kdocker', 'ec_mac', ?, ?, 'command', 'kdocker', ?, ?, ?, ?)`,
		)
		.run(
			orgId,
			operator,
			JSON.stringify(input.allowedPackages ?? []),
			now,
			now,
			input.removed ? now : null,
		)
}

function savePackage(s: ReturnType<typeof setup>, id: string, owner: string) {
	s.sqlite
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES (?, ?, ?, ?, '', ?)`,
		)
		.run(id, owner, id, id, `source-${id}`)
}

/** A run in the context's org, so package lookups use that org. */
function orgRun(
	s: ReturnType<typeof setup>,
	userId: string,
	input: {
		scopes?: Array<string> | null
		packages?: { entries: Array<string>; all: Array<string>; truncated?: true }
	} = {},
) {
	const ctx = s.runCtx(
		userId,
		'execution-context-run',
		input.scopes ?? null,
		null,
		input.packages,
	)
	return {
		...ctx,
		callerContext: {
			...ctx.callerContext,
			request: {
				actor: { userId, username: userId },
				org: { id: orgId, slug: 'acme' },
				credential: { kind: 'session', id: null },
			},
		},
	} as unknown as ApiInvocationContext
}

const namedArgs = {
	commandId: 'cmd_abcdef123',
	capability: 'kdocker',
	args: ['restart', 'plex'],
	command: 'kdocker restart plex',
	cwd: '',
	envKeys: [],
	background: false,
}

test('the operator runs a named command with the shell off, and the audit row names it', async () => {
	const s = setup()
	defineCommand(s)
	await expect(
		authorizeContextCommand(orgRun(s, operator), namedArgs),
	).resolves.toEqual({ ok: true, commandId: 'cmd_abcdef123' })
	expect(s.audits[0]).toMatchObject({
		event: 'command_started',
		detail: {
			command: 'kdocker restart plex',
			capability: 'kdocker',
			capabilityId: 'mcap_kdocker',
			cwd: null,
		},
	})
	await expect(
		authorizeContextCommand(orgRun(s, operator), {
			lifecycle: 'status',
			capability: 'kdocker',
		}),
	).resolves.toEqual({ ok: true })
	// The shell stays off.
	await expect(
		authorizeContextCommand(orgRun(s, operator), s.args),
	).rejects.toMatchObject({ code: 'execution_context_commands_off' })
})

test('a named command the machine does not define, or removed, is refused by name', async () => {
	const missing = setup({ commands: true })
	await expect(
		authorizeContextCommand(orgRun(missing, operator), namedArgs),
	).rejects.toMatchObject({
		code: 'machine_capability_off',
		message: expect.stringContaining('kody context capability add command'),
	})
	const removed = setup({ commands: true })
	defineCommand(removed, { removed: true })
	await expect(
		authorizeContextCommand(orgRun(removed, operator), namedArgs),
	).rejects.toMatchObject({ code: 'machine_capability_off' })
	expect(removed.audits).toHaveLength(0)
})

test('a named command is refused for other people and for a token without the scope', async () => {
	const s = setup()
	defineCommand(s)
	await setSharing(s.callerFor(operator), 'ec_mac', { allMembers: true })
	await expect(
		authorizeContextCommand(orgRun(s, 'user_friend'), namedArgs),
	).rejects.toMatchObject({ code: 'machine_capability_not_granted' })
	await expect(
		authorizeContextCommand(
			orgRun(s, operator, { scopes: ['execution_context:command'] }),
			namedArgs,
		),
	).rejects.toMatchObject({ code: 'machine_capability_not_granted' })
	await expect(
		authorizeContextCommand(
			orgRun(s, operator, { scopes: ['machine_capability:use'] }),
			namedArgs,
		),
	).resolves.toMatchObject({ ok: true })
})

test('a named command checks the packages Kody served to the run', async () => {
	const s = setup()
	defineCommand(s)
	savePackage(s, 'pkg_own', orgId)
	savePackage(s, 'pkg_other', 'org_someone_else')
	const run = (entries: Array<string>, truncated?: true) =>
		authorizeContextCommand(
			orgRun(s, operator, {
				packages: {
					entries,
					all: entries,
					...(truncated ? { truncated } : {}),
				},
			}),
			namedArgs,
		)
	await expect(run(['pkg_own'])).resolves.toMatchObject({ ok: true })
	await expect(run(['pkg_own', 'pkg_other'])).rejects.toMatchObject({
		code: 'machine_capability_package_not_allowed',
		message: expect.stringContaining('pkg_other'),
		details: { capability: 'kdocker', packageIds: ['pkg_other'] },
	})
	await expect(run(['pkg_own'], true)).rejects.toMatchObject({
		code: 'machine_capability_package_not_allowed',
	})

	const listed = setup()
	defineCommand(listed, { allowedPackages: ['pkg_listed'] })
	savePackage(listed, 'pkg_own', orgId)
	const listedRun = (entries: Array<string>) =>
		authorizeContextCommand(
			orgRun(listed, operator, { packages: { entries, all: entries } }),
			namedArgs,
		)
	await expect(listedRun(['pkg_listed'])).resolves.toMatchObject({ ok: true })
	await expect(listedRun(['pkg_own'])).rejects.toMatchObject({
		code: 'machine_capability_package_not_allowed',
	})
	// Ad hoc code is refused once the command is limited to listed packages.
	await expect(
		authorizeContextCommand(orgRun(listed, operator), namedArgs),
	).rejects.toMatchObject({ code: 'machine_capability_package_not_allowed' })
})

test('a shell command logs the packages a package rule would refuse, and still runs', async () => {
	const s = setup({ commands: true })
	savePackage(s, 'pkg_own', orgId)
	await authorizeContextCommand(
		orgRun(s, operator, {
			packages: {
				entries: ['pkg_own', 'pkg_other'],
				all: ['pkg_own', 'pkg_other'],
			},
		}),
		s.args,
	)
	expect(s.audits[0]?.detail).toMatchObject({
		wouldBlockPackageIds: ['pkg_other'],
	})
})

function defineLan(
	s: ReturnType<typeof setup>,
	input: { allowedPackages?: Array<string> } = {},
) {
	s.sqlite
		.prepare(
			`INSERT INTO machine_capabilities (id, context_id, org_id, operator_user_id, kind, name,
				allowed_packages_json, created_at, updated_at)
			 VALUES ('mcap_nas', 'ec_mac', ?, ?, 'lan', 'nas', ?, ?, ?)`,
		)
		.run(orgId, operator, JSON.stringify(input.allowedPackages ?? []), now, now)
}

const lanArgs = { capability: 'nas', host: '192.168.1.10', port: 5001 }

test('the operator reaches a named local network destination, and the audit row names it and the address', async () => {
	const s = setup()
	defineLan(s)
	savePackage(s, 'pkg_own', orgId)
	await expect(
		authorizeContextLan(
			orgRun(s, operator, {
				packages: { entries: ['pkg_own'], all: ['pkg_own'] },
			}),
			lanArgs,
		),
	).resolves.toEqual({ ok: true })
	expect(s.audits[0]).toMatchObject({
		event: 'lan_used',
		detail: {
			capability: 'nas',
			capabilityId: 'mcap_nas',
			host: '192.168.1.10',
			port: 5001,
			entryPackageIds: ['pkg_own'],
		},
	})
})

test('a named local network destination is refused when undefined, for other people, without the scope, and for packages not allowed', async () => {
	const missing = setup()
	// A command of the same name is not a local network destination.
	defineCommand(missing)
	await expect(
		authorizeContextLan(orgRun(missing, operator), {
			...lanArgs,
			capability: 'kdocker',
		}),
	).rejects.toMatchObject({
		code: 'machine_capability_off',
		message: expect.stringContaining('kody context capability add lan'),
	})

	const s = setup()
	defineLan(s)
	await setSharing(s.callerFor(operator), 'ec_mac', { allMembers: true })
	await expect(
		authorizeContextLan(orgRun(s, 'user_friend'), lanArgs),
	).rejects.toMatchObject({ code: 'machine_capability_not_granted' })
	await expect(
		authorizeContextLan(
			orgRun(s, operator, { scopes: ['execution_context:command'] }),
			lanArgs,
		),
	).rejects.toMatchObject({ code: 'machine_capability_not_granted' })
	savePackage(s, 'pkg_other', 'org_someone_else')
	await expect(
		authorizeContextLan(
			orgRun(s, operator, {
				packages: { entries: ['pkg_other'], all: ['pkg_other'] },
			}),
			lanArgs,
		),
	).rejects.toMatchObject({
		code: 'machine_capability_package_not_allowed',
		message: expect.stringContaining('local network destination "nas"'),
	})
	for (const bad of [
		{ ...lanArgs, port: 0 },
		{ ...lanArgs, host: '' },
		{ host: '192.168.1.10', port: 80 },
	]) {
		await expect(
			authorizeContextLan(orgRun(s, operator), bad),
		).rejects.toMatchObject({ code: 'invalid_request' })
	}
	expect(s.audits.filter((audit) => audit.event === 'lan_used')).toEqual([])
	await expect(
		authorizeContextLan(s.runCtx(operator, 'user'), lanArgs),
	).rejects.toMatchObject({
		code: 'execution_context_command_requires_context',
	})
})
