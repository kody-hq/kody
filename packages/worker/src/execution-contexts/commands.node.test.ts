import { DatabaseSync } from 'node:sqlite'
import { ecpDefaultGrant } from '@kody-internal/shared/execution-context-protocol/index.ts'
import { expect, test, vi } from 'vitest'
import { type EffectivePermissions } from '#worker/authorization/authorize.ts'
import { type ApiInvocationContext } from '#worker/open-api/context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { authorizeContextCommand } from './commands.ts'
import {
	type ExecutionContextCaller,
	setSharing,
	updateContext,
} from './service.ts'
import { getExecutionContext, parseGrant } from './store.ts'

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
		INSERT INTO org_memberships (org_id, user_id, role, created_at)
			VALUES ('${orgId}', 'user_friend', 'member', '${now}'),
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
	) =>
		({
			env,
			principal: { kind, ecid: 'ec_mac', runId: 'run_1', scopes },
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
	expect(ecpDefaultGrant.commands).toEqual({ enabled: false })
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

test('shares and all_members withhold the command grant unless the share names commands', async () => {
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
	await setSharing(owner, 'ec_mac', {
		add: [
			{
				subject: { type: 'user', id: 'user_friend' },
				preset: 'use',
				commands: true,
			},
		],
	})
	await expect(
		authorizeContextCommand(s.runCtx('user_friend'), s.args),
	).resolves.toMatchObject({ ok: true })
	await expect(
		authorizeContextCommand(s.runCtx('user_teammate'), s.args),
	).rejects.toMatchObject({ code: 'execution_context_command_not_granted' })
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

test('an expired command share confers nothing', async () => {
	const s = setup({ commands: true })
	await setSharing(s.callerFor(operator), 'ec_mac', {
		add: [
			{
				subject: { type: 'user', id: 'user_friend' },
				preset: 'use',
				commands: true,
			},
		],
	})
	await expect(
		authorizeContextCommand(s.runCtx('user_friend'), s.args),
	).resolves.toMatchObject({ ok: true })
	s.sqlite
		.prepare(
			`UPDATE grants SET expires_at = '2000-01-01T00:00:00.000Z' WHERE resource_id = 'ec_mac'`,
		)
		.run()
	await expect(
		authorizeContextCommand(s.runCtx('user_friend'), s.args),
	).rejects.toMatchObject({ code: 'execution_context_command_not_granted' })
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
			profileGrants: null,
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
