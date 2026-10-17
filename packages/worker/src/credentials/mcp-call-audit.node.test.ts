/**
 * Each MCP tool call writes its own audit row. The connection decision stays
 * one `credential.resolve` row, and the call row never holds arguments or
 * return values.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { attestedPackageStamp } from './package-stamp.ts'
import { resolveCredential } from './resolve-credential.ts'

const argumentSentinel = 'ARGUMENT_SENTINEL_9f3a'
const resultSentinel = 'RESULT_SENTINEL_9f3a'
const messageSentinel = 'user@example.com'
const secretSentinel = 'sk-live-argument'

type HubCall = {
	serverId: string
	toolName: string
	args: Record<string, unknown>
}

const hub = vi.hoisted(() => ({
	calls: [] as Array<HubCall>,
	impl: null as null | ((input: HubCall) => Promise<CallToolResult>),
}))

const scheduledAudits = vi.hoisted(() => [] as Array<Promise<unknown>>)

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	waitUntil: (promise: Promise<unknown>) => {
		scheduledAudits.push(promise)
	},
}))

vi.mock('#worker/mcp-client/hub-client.ts', () => ({
	callMcpServerTool: (input: HubCall) => {
		hub.calls.push(input)
		if (!hub.impl) throw new Error('MCP hub fixture is not set.')
		return hub.impl(input)
	},
}))

const serverId = 'server-notion'
const serverName = 'Notion\n\u200b'
const packageId = 'pkg-notion'

type AuditRow = {
	org_id: string
	actor_user_id: string | null
	actor_username: string | null
	credential_kind: string | null
	credential_id: string | null
	action: string
	resource_type: string | null
	resource_id: string | null
	result: string
	details_json: string | null
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const auditDb = createAuditTestDb()
	const env = {
		APP_DB: db,
		AUDIT_DB: auditDb,
		...createInMemoryUserMeterEnv().env,
	} as unknown as Env
	const people = Object.fromEntries(
		(['bea', 'ann'] as const).map((username) => {
			const stableUserId = testStableUserIdFromEmail(`${username}@example.com`)
			return [
				username,
				{ stableUserId, personId: personIdFromStored(stableUserId) },
			]
		}),
	) as Record<
		'bea' | 'ann',
		{ stableUserId: string; personId: ReturnType<typeof personIdFromStored> }
	>
	for (const [username, person] of Object.entries(people)) {
		await provisionPersonalOrg(db, {
			stableUserId: person.stableUserId,
			username,
			createdAt: '2026-10-16T00:00:00.000Z',
		})
	}
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: people.bea.personId,
			audit: createTestOrgAuditWriter(),
			slug: 'acme-mcp',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'acme-mcp'`)
		.first<{ id: string }>()
	const acmeId = ownerIdFromStored(acme!.id)
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(acmeId, people.ann.stableUserId, '2026-10-16T00:00:00.000Z')
		.run()
	const requestAs = (person: keyof typeof people, role: OrgRole) =>
		deriveRequestContext({
			user: { userId: people[person].personId, username: person },
			source: { kind: 'mcp-oauth' },
			orgBinding: { org: { id: acmeId, slug: 'acme-mcp' }, role },
		})
	const connect = (actor: ReturnType<typeof requestAs>) =>
		resolveCredential({
			env,
			orgId: acmeId,
			actor,
			packageStamp: attestedPackageStamp(packageId),
			baseUrl: 'https://example.com',
			credential: {
				use: 'mcp-connection',
				serverId,
				serverName,
			},
		})
	const audits = async () => {
		await Promise.all(scheduledAudits.splice(0))
		const { results } = await auditDb
			.prepare(
				`SELECT org_id, actor_user_id, actor_username, credential_kind,
					credential_id, action, resource_type, resource_id, result, details_json
				 FROM org_audit_events
				 ORDER BY rowid`,
			)
			.all<AuditRow>()
		return results
	}
	hub.calls = []
	hub.impl = null
	scheduledAudits.length = 0
	return { env, acmeId, people, requestAs, connect, audits }
}

function details(row: AuditRow | undefined) {
	return JSON.parse(row?.details_json ?? 'null') as Record<string, unknown>
}

function withoutDuration(row: Record<string, unknown>) {
	const { durationMs, ...rest } = row
	expect(durationMs).toEqual(expect.any(Number))
	expect(Number.isInteger(durationMs)).toBe(true)
	expect(durationMs as number).toBeGreaterThanOrEqual(0)
	expect(durationMs as number).toBeLessThan(60_000)
	return rest
}

test('each tool call writes an mcp.call row and the resolution stays one credential.resolve row', async () => {
	const t = await setup()
	const args = { query: argumentSentinel, token: secretSentinel }
	hub.impl = async () => ({
		content: [{ type: 'text', text: resultSentinel }],
	})
	const connection = await t.connect(t.requestAs('bea', 'owner'))
	const result = await connection.callTool({ toolName: 'search\u0000', args })

	const protocol = new Error(
		`Structured content does not match schema for ${messageSentinel}`,
	)
	protocol.name = 'McpError'
	;(protocol as unknown as { code: number }).code = -32602
	hub.impl = async () => {
		throw protocol
	}
	const thrown = await connection
		.callTool({ toolName: 'x'.repeat(200), args })
		.then(
			() => null,
			(error: unknown) => error,
		)

	expect(result.content).toEqual([{ type: 'text', text: resultSentinel }])
	expect(thrown).toBe(protocol)
	expect(hub.calls.map((call) => call.args)).toEqual([args, args])
	expect(scheduledAudits).toHaveLength(3)

	const rows = await t.audits()
	expect(rows.map((row) => [row.action, row.result])).toEqual([
		['credential.resolve', 'success'],
		['mcp.call', 'success'],
		['mcp.call', 'failure'],
	])
	expect(rows[0]).toMatchObject({
		org_id: t.acmeId,
		actor_user_id: t.people.bea.stableUserId,
		actor_username: 'bea',
		credential_kind: 'mcp-oauth',
		credential_id: null,
		resource_type: 'mcp-server',
		resource_id: serverId,
	})
	expect(details(rows[0])).toEqual({
		use: 'mcp-connection',
		name: serverName,
		actorKind: 'person',
		ownerKind: 'org',
		packageStampKind: 'attested',
		packageId,
		serverId,
	})
	for (const row of rows.slice(1)) {
		expect(row).toMatchObject({
			org_id: t.acmeId,
			actor_user_id: t.people.bea.stableUserId,
			actor_username: 'bea',
			credential_kind: 'mcp-oauth',
			resource_type: 'mcp-server',
			resource_id: serverId,
		})
	}
	expect(withoutDuration(details(rows[1]!))).toEqual({
		use: 'mcp-connection',
		toolName: 'search',
		serverName: 'Notion',
		serverId,
		actorKind: 'person',
		ownerKind: 'org',
		packageStampKind: 'attested',
		packageId,
	})
	expect(withoutDuration(details(rows[2]!))).toEqual({
		use: 'mcp-connection',
		toolName: 'x'.repeat(128),
		serverName: 'Notion',
		serverId,
		actorKind: 'person',
		ownerKind: 'org',
		packageStampKind: 'attested',
		packageId,
		errorClass: 'McpError:-32602',
	})
	const serialized = JSON.stringify(rows)
	expect(serialized).not.toContain(argumentSentinel)
	expect(serialized).not.toContain(resultSentinel)
	expect(serialized).not.toContain(messageSentinel)
	expect(serialized).not.toContain(secretSentinel)
	expect(serialized).not.toContain('\\u0000')
})

test('a tool result flagged isError is a failure, and a hostile error class is not stored', async () => {
	const t = await setup()
	const content = [{ type: 'text' as const, text: resultSentinel }]
	hub.impl = async () => ({ content, isError: true })
	const connection = await t.connect(t.requestAs('bea', 'owner'))
	const result = await connection.callTool({
		toolName: messageSentinel,
		args: { note: argumentSentinel },
	})

	const hostile = new Error(`leaked ${messageSentinel} ${secretSentinel}`)
	hostile.name = messageSentinel
	;(hostile as unknown as { code: string }).code = secretSentinel
	hub.impl = async () => {
		throw hostile
	}
	const thrown = await connection
		.callTool({
			toolName: 'sk-live-tooltoken',
			args: { note: argumentSentinel },
		})
		.then(
			() => null,
			(error: unknown) => error,
		)

	expect(result).toEqual({ content, isError: true })
	expect(thrown).toBe(hostile)
	const rows = await t.audits()
	expect(rows.map((row) => [row.action, row.result])).toEqual([
		['credential.resolve', 'success'],
		['mcp.call', 'failure'],
		['mcp.call', 'failure'],
	])
	expect(withoutDuration(details(rows[1]!))).toMatchObject({
		toolName: 'redacted',
		errorClass: 'McpToolResult',
	})
	expect(withoutDuration(details(rows[2]!))).toMatchObject({
		toolName: 'redacted',
		errorClass: 'unknown',
	})
	const serialized = JSON.stringify(rows)
	expect(serialized).not.toContain(argumentSentinel)
	expect(serialized).not.toContain(resultSentinel)
	expect(serialized).not.toContain(messageSentinel)
	expect(serialized).not.toContain(secretSentinel)
	expect(serialized).not.toContain('sk-live-tooltoken')
})

test('a payload the caller rejects is a failure row and the rejection is rethrown', async () => {
	const t = await setup()
	const rejection = new McpCallerError(
		`too many MCP content blocks for ${resultSentinel}`,
	)
	hub.impl = async () => ({
		content: [{ type: 'text', text: resultSentinel }],
	})
	const connection = await t.connect(t.requestAs('bea', 'owner'))
	const thrown = await connection
		.callTool({
			toolName: 'search',
			args: { note: argumentSentinel },
			accept() {
				throw rejection
			},
		})
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(thrown).toBe(rejection)
	const rows = await t.audits()
	expect(rows.map((row) => [row.action, row.result])).toEqual([
		['credential.resolve', 'success'],
		['mcp.call', 'failure'],
	])
	expect(withoutDuration(details(rows[1]!)).errorClass).toBe('McpCallerError')
	const serialized = JSON.stringify(rows)
	expect(serialized).not.toContain(argumentSentinel)
	expect(serialized).not.toContain(resultSentinel)
})

test('a denied connection writes credential.resolve and does not call the server', async () => {
	const t = await setup()
	hub.impl = async () => ({ content: [] })
	const error = await t.connect(t.requestAs('ann', 'member')).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(error).toBeInstanceOf(AuthorizationError)
	expect(error).toMatchObject({
		code: 'missing_permission',
		permission: 'integration:use',
	})
	expect(hub.calls).toEqual([])
	const rows = await t.audits()
	expect(rows.map((row) => [row.action, row.result])).toEqual([
		['credential.resolve', 'denied'],
	])
	expect(details(rows[0])).toMatchObject({
		use: 'mcp-connection',
		reason: 'missing_permission',
	})
})

test('an audit write failure does not fail the tool call or record its arguments', async () => {
	const t = await setup()
	const env = {
		...t.env,
		AUDIT_DB: {
			prepare() {
				throw new Error('audit db unavailable')
			},
		} as unknown as D1Database,
	} as Env
	hub.impl = async () => ({
		content: [{ type: 'text', text: resultSentinel }],
	})
	consoleError.mockImplementation(() => {})
	const connection = await resolveCredential({
		env,
		orgId: t.acmeId,
		actor: t.requestAs('bea', 'owner'),
		baseUrl: 'https://example.com',
		credential: {
			use: 'mcp-connection',
			serverId,
			serverName,
		},
	})
	await expect(
		connection.callTool({
			toolName: 'search',
			args: { token: secretSentinel },
		}),
	).resolves.toMatchObject({
		content: [{ type: 'text', text: resultSentinel }],
	})
	await Promise.all(scheduledAudits.splice(0))
	const messages = consoleError.mock.calls.map((call) => call[0])
	expect(messages).toEqual([
		'Failed to record credential resolution audit event:',
		'Failed to record MCP tool call audit event:',
	])
	expect(consoleError.mock.calls[0]?.[1]).toMatchObject({
		action: 'credential.resolve',
		result: 'success',
		errorName: 'Error',
	})
	expect(consoleError.mock.calls[1]?.[1]).toMatchObject({
		action: 'mcp.call',
		result: 'success',
		errorName: 'Error',
	})
	expect(JSON.stringify(consoleError.mock.calls[0]?.[1])).not.toContain(
		'audit db unavailable',
	)
	expect(JSON.stringify(consoleError.mock.calls[1]?.[1])).not.toContain(
		'audit db unavailable',
	)
	const serialized = JSON.stringify(consoleError.mock.calls, (_key, value) =>
		value instanceof Error ? value.message : value,
	)
	expect(serialized).not.toContain(secretSentinel)
	expect(serialized).not.toContain(resultSentinel)
})
