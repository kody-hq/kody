import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { orgTransferMemoriesStayNote } from '#worker/org-transfer/report.ts'
import { adminOrgResourceTransferCapability } from './admin-org-resource-transfer.ts'

const mocks = vi.hoisted(() => ({ runOrgResourceTransfer: vi.fn() }))

vi.mock('#worker/org-transfer/apply.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	runOrgResourceTransfer: mocks.runOrgResourceTransfer,
}))

function createContext(roles: Array<string>) {
	return {
		env: { APP_DB: {} as D1Database } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored('actor-1'),
				username: 'actor',
				email: 'actor@example.com',
				displayName: 'Actor',
				roles,
			},
		}),
	}
}

const summary = {
	from: { id: 'org-a', slug: 'bradhave' },
	to: { id: 'org-b', slug: 'haveman' },
	counts: { saved_packages: 1 },
	packages: [{ id: 'p1', from_name: '@bradhave/x', to_name: '@haveman/x' }],
	repos: [],
	secrets: [{ scope: 'user', binding: '', name: 'API_KEY' }],
	integrations: [],
	oauth_apps: [],
	mcp_servers: [{ id: 'server-1', name: 'linear' }],
	webhooks: [
		{
			package: 'x',
			name: 'ping',
			url_changed: true,
			old_path_prefix: '/@bradhave/webhooks/x/ping/',
			new_path_prefix: '/@haveman/webhooks/x/ping/',
			manage_path: '/@haveman/-/webhooks',
		},
	],
	enablements: [],
	jobs: [],
	storages: [],
	orphans: [],
	clashes: [],
	blockers: [],
	warnings: [],
	kept: {
		memories: { count: 0, note: orgTransferMemoriesStayNote },
	},
}

test('adminOrgResourceTransfer is admin-only, destructive, and audited', async () => {
	await expect(
		adminOrgResourceTransferCapability.handler(
			{ fromOrgId: 'org-a', toOrgId: 'org-b', mode: 'apply' },
			createContext(['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.runOrgResourceTransfer).not.toHaveBeenCalled()

	mocks.runOrgResourceTransfer.mockResolvedValue({
		mode: 'apply',
		outcome: 'applied',
		applied: true,
		summary,
		fingerprint: 'f'.repeat(64),
		refusals: [],
		failure: null,
		backupKey: 'org-resource-transfers/org-a/org-b/x.json',
		storage: [{ storageId: 'package:p1', kvEntries: 1, sqlRows: {} }],
		leftovers: {},
		postCommitWarnings: [],
		mcpConnections: [
			{
				id: 'server-1',
				name: 'linear',
				source_removed: true,
				state: 'authenticating',
				needs_authorization: true,
				authorize_url:
					'https://heykody.dev/@haveman/-/mcp-servers/server-1/authorize',
			},
		],
	})
	const result = await adminOrgResourceTransferCapability.handler(
		{
			fromOrgId: 'org-a',
			toOrgId: 'org-b',
			mode: 'apply',
			skipOrphans: true,
			expectedFingerprint: 'f'.repeat(64),
		},
		createContext(['admin']),
	)
	expect(mocks.runOrgResourceTransfer).toHaveBeenCalledWith(
		expect.objectContaining({
			fromOrgId: 'org-a',
			toOrgId: 'org-b',
			mode: 'apply',
			skipOrphans: true,
			expectedFingerprint: 'f'.repeat(64),
			actorUserId: 'actor-1',
		}),
	)
	expect(result).toMatchObject({
		outcome: 'applied',
		fingerprint: 'f'.repeat(64),
		applied: true,
		webhooks: summary.webhooks,
		mcp_connections: [
			expect.objectContaining({ id: 'server-1', needs_authorization: true }),
		],
		backup_key: 'org-resource-transfers/org-a/org-b/x.json',
		packages: summary.packages,
		storage_copies: [{ storage_id: 'package:p1', kv_entries: 1, sql_rows: {} }],
	})
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'adminOrgResourceTransfer',
			result: 'success',
			reason: expect.stringContaining('backup=org-resource-transfers/'),
		}),
	)
})

test('refused and failed outcomes come back as structured results', async () => {
	mocks.runOrgResourceTransfer.mockResolvedValue({
		mode: 'apply',
		outcome: 'failed',
		applied: false,
		summary,
		fingerprint: 'a'.repeat(64),
		refusals: [],
		failure: {
			committed: false,
			failed_step: 'storage_copy',
			failed_undo: ['storage package:p1'],
			backup_key: 'org-resource-transfers/org-a/org-b/y.json',
			message: 'Storage package:p1 copy did not verify.',
		},
		backupKey: 'org-resource-transfers/org-a/org-b/y.json',
		storage: [],
		leftovers: {},
		postCommitWarnings: [],
		mcpConnections: [],
	})
	const failed = await adminOrgResourceTransferCapability.handler(
		{ fromOrgId: 'org-a', toOrgId: 'org-b', mode: 'apply' },
		createContext(['admin']),
	)
	expect(failed.failure).toMatchObject({
		committed: false,
		failed_step: 'storage_copy',
	})
	expect(logAuditEventSpy).toHaveBeenLastCalledWith(
		expect.objectContaining({
			result: 'failure',
			reason: expect.stringMatching(
				/outcome=failed;failed_step=storage_copy;failed_undo=storage package:p1;.*backup=org-resource-transfers\/org-a\/org-b\/y\.json/,
			),
		}),
	)

	mocks.runOrgResourceTransfer.mockResolvedValue({
		mode: 'apply',
		outcome: 'refused',
		applied: false,
		summary,
		fingerprint: 'b'.repeat(64),
		refusals: [{ code: 'plan_drifted', message: 'The plan changed.' }],
		failure: null,
		backupKey: null,
		storage: [],
		leftovers: {},
		postCommitWarnings: [],
		mcpConnections: [],
	})
	const refused = await adminOrgResourceTransferCapability.handler(
		{
			fromOrgId: 'org-a',
			toOrgId: 'org-b',
			mode: 'apply',
			expectedFingerprint: 'a'.repeat(64),
		},
		createContext(['admin']),
	)
	expect(refused.refusals).toEqual([
		{ code: 'plan_drifted', message: 'The plan changed.' },
	])
	expect(logAuditEventSpy).toHaveBeenLastCalledWith(
		expect.objectContaining({
			result: 'failure',
			reason: expect.stringContaining('refusals=plan_drifted'),
		}),
	)
})
