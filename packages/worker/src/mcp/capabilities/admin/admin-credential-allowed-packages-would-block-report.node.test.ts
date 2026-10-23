import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'

const mocks = vi.hoisted(() => ({
	buildAllowedPackagesWouldBlockReport: vi.fn(),
}))

vi.mock('#worker/credentials/allowed-packages-would-block.ts', () => ({
	allowedPackagesWouldBlockReportOwnerLimitMax: 500,
	buildAllowedPackagesWouldBlockReport: (...args: Array<unknown>) =>
		mocks.buildAllowedPackagesWouldBlockReport(...args),
}))

const { adminCredentialAllowedPackagesWouldBlockReportCapability } =
	await import('./admin-credential-allowed-packages-would-block-report.ts')

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

const report = {
	since: '2026-10-16',
	until: null,
	totals: {
		owners: 1,
		credentials: 1,
		packages: 1,
		credentialPackagePairs: 1,
		selfAuthoredPackages: 1,
		adoptedPackages: 0,
		observations: 3,
	},
	ownersTruncated: false,
	owners: [],
}

test('allowed-packages would-block report is admin-only and read-only', async () => {
	await expect(
		adminCredentialAllowedPackagesWouldBlockReportCapability.handler(
			{ ownerLimit: 100 },
			createContext(['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.buildAllowedPackagesWouldBlockReport).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'mcp_capability_denied',
			reason: 'role',
		}),
	)

	mocks.buildAllowedPackagesWouldBlockReport.mockResolvedValueOnce(report)
	const result =
		await adminCredentialAllowedPackagesWouldBlockReportCapability.handler(
			{ since: '2026-10-16', ownerLimit: 100 },
			createContext(['admin']),
		)
	expect(result).toEqual(report)
	expect(mocks.buildAllowedPackagesWouldBlockReport).toHaveBeenCalledWith({
		db: expect.anything(),
		since: '2026-10-16',
		until: null,
		ownerLimit: 100,
	})

	mocks.buildAllowedPackagesWouldBlockReport.mockResolvedValueOnce(report)
	await adminCredentialAllowedPackagesWouldBlockReportCapability.handler(
		{ ownerLimit: 100 },
		createContext(['admin']),
	)
	const secondCall = mocks.buildAllowedPackagesWouldBlockReport.mock
		.calls[1]?.[0] as { since: string } | undefined
	const defaultSince = secondCall?.since
	expect(defaultSince).toMatch(/^\d{4}-\d{2}-\d{2}$/)
	expect(auditEventSummaries()).toEqual([
		'mcp_capability_denied:failure',
		'adminCredentialAllowedPackagesWouldBlockReport:success',
		'adminCredentialAllowedPackagesWouldBlockReport:success',
	])
})
