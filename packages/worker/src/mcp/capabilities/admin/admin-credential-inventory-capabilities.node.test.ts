import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { adminCredentialBackfillCapability } from './admin-credential-backfill.ts'
import { adminCredentialInventoryScanCapability } from './admin-credential-inventory-scan.ts'

const mocks = vi.hoisted(() => ({
	runCredentialInventoryScanStep: vi.fn(),
	getCredentialInventoryReport: vi.fn(),
	runCredentialBackfill: vi.fn(),
}))

vi.mock('#worker/credentials/credential-inventory.ts', () => ({
	credentialInventoryFailureListMax: 50,
	credentialInventoryScanLimitDefault: 25,
	credentialInventoryScanLimitMax: 50,
	credentialInventoryTallyMax: 25,
	runCredentialInventoryScanStep: (...args: Array<unknown>) =>
		mocks.runCredentialInventoryScanStep(...args),
	getCredentialInventoryReport: (...args: Array<unknown>) =>
		mocks.getCredentialInventoryReport(...args),
	runCredentialBackfill: (...args: Array<unknown>) =>
		mocks.runCredentialBackfill(...args),
}))

const noPlacements = {
	header: 0,
	query: 0,
	'header-custom': 0,
	basic: 0,
	path: 0,
	url: 0,
	body: 0,
	signing: 0,
	binding: 0,
	other: 0,
}

const fullReport = {
	packages: {
		scanned: 28,
		unpublished: 0,
		failed: 0,
		withPlaceholders: 1,
		withSlots: 0,
	},
	placeholders: {
		secret: 1,
		'secret-basic': 0,
		'integration-token': 0,
		vault: 0,
		computed: 0,
	},
	unparsedModules: 0,
	references: {
		total: 1,
		attributed: 1,
		unattributed: 0,
		byPlacement: { ...noPlacements, header: 1 },
		unattributedByPlacement: noPlacements,
		otherByContext: {
			'sdk-option': 0,
			object: 0,
			argument: 0,
			return: 0,
			assignment: 0,
			array: 0,
			'default-param': 0,
			comparison: 0,
			'unused-binding': 0,
			'reassigned-binding': 0,
			'template-computed': 0,
			'url-host': 0,
			unparsed: 0,
			display: 0,
			other: 0,
		},
		bodyByEndpoint: { login: 0, other: 0, unknown: 0 },
		bodyFields: [],
		sdkOptions: [],
		argumentCallees: [],
	},
	vault: { byPlacement: noPlacements },
	signing: { placeholderKeys: 0, jwtSignCalls: 0, packagesWithSigning: 0 },
	slots: { total: 0, attributed: 0, byKind: { secret: 0, oauth: 0, mcp: 0 } },
	credentialsReferenced: 1,
	failures: [],
}

function createContext(roles: Array<string>) {
	const actorId = personIdFromStored('actor-1')
	return {
		env: {
			APP_DB: {
				prepare(_sql: string) {
					return {
						bind(stableUserId: string) {
							return {
								async first() {
									if (stableUserId !== actorId) return null
									return {
										id: 1,
										email: 'actor@example.com',
										username: 'actor',
									}
								},
							}
						},
					}
				},
			} as unknown as D1Database,
		} as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: actorId,
				username: 'actor',
				email: 'actor@example.com',
				displayName: 'Actor',
				roles,
			},
		}),
	}
}

test('credential inventory scan is admin-only and returns the report once the run completes', async () => {
	await expect(
		adminCredentialInventoryScanCapability.handler({}, createContext(['user'])),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.runCredentialInventoryScanStep).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'mcp_capability_denied',
			reason: 'role',
		}),
	)

	mocks.runCredentialInventoryScanStep.mockResolvedValueOnce({
		runId: 'run-1',
		complete: false,
		page: { scanned: 25, unpublished: 0, failed: 0 },
	})
	const page = await adminCredentialInventoryScanCapability.handler(
		{},
		createContext(['admin']),
	)
	expect(page.report).toBeNull()
	expect(mocks.getCredentialInventoryReport).not.toHaveBeenCalled()
	expect(mocks.runCredentialInventoryScanStep).toHaveBeenCalledWith({
		env: expect.anything(),
		baseUrl: 'https://heykody.dev',
		initiatedByUserId: personIdFromStored('actor-1'),
		runId: undefined,
		limit: undefined,
	})

	mocks.runCredentialInventoryScanStep.mockResolvedValueOnce({
		runId: 'run-1',
		complete: true,
		page: { scanned: 3, unpublished: 0, failed: 0 },
	})
	mocks.getCredentialInventoryReport.mockResolvedValueOnce({
		runId: 'run-1',
		complete: true,
		report: fullReport,
	})
	const last = await adminCredentialInventoryScanCapability.handler(
		{ runId: 'run-1' },
		createContext(['admin']),
	)
	expect(last.report).toEqual(fullReport)
	expect(auditEventSummaries()).toEqual([
		'mcp_capability_denied:failure',
		'adminCredentialInventoryScan:success',
		'adminCredentialInventoryScan:success',
	])
})

test('credential backfill is admin-only and defaults to a dry run', async () => {
	await expect(
		adminCredentialBackfillCapability.handler(
			{ runId: 'run-1' },
			createContext(['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.runCredentialBackfill).not.toHaveBeenCalled()

	const counts = {
		failedPackages: 0,
		credentials: 0,
		missingRows: 0,
		provider: { write: 0, alreadySet: 0, none: 0, conflicting: 0, invalid: 0 },
		inject: {
			write: 0,
			header: 0,
			query: 0,
			alreadySet: 0,
			default: 0,
			mixed: 0,
			unsupported: 0,
			unused: 0,
		},
	}
	mocks.runCredentialBackfill.mockImplementation(
		async (input: { runId: string; dryRun: boolean }) => ({
			runId: input.runId,
			dryRun: input.dryRun,
			counts,
			writtenRows: 0,
		}),
	)
	const dryRun = await adminCredentialBackfillCapability.handler(
		{ runId: 'run-1' },
		createContext(['admin']),
	)
	expect(dryRun.dryRun).toBe(true)
	const applied = await adminCredentialBackfillCapability.handler(
		{ runId: 'run-1', dryRun: false },
		createContext(['admin']),
	)
	expect(applied.dryRun).toBe(false)
	expect(mocks.runCredentialBackfill).toHaveBeenNthCalledWith(1, {
		env: expect.anything(),
		runId: 'run-1',
		dryRun: true,
	})
})
