import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	runWithCurrentSecretAuthority,
	runWithSecretAuthorityScope,
} from '#mcp/secrets/secret-authority.ts'
import * as needsClosure from '#worker/credentials/credential-needs-closure.ts'
import * as stampPresence from '#worker/credentials/credential-stamp-presence.ts'
import * as packageRepo from '#worker/package-registry/repo.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import { personalOrgAccessD1 } from '#worker/test-support/org-binding-query.ts'
import { claimedPackageStamp } from '#worker/credentials/package-stamp.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import {
	integrationTokenRefreshCapability,
	refreshIntegrationTokenForPackage,
} from './integration-token-refresh.ts'

const resolveCredential = vi.hoisted(() => vi.fn())

vi.mock('#worker/credentials/resolve-credential.ts', () => ({
	resolveCredential,
}))

const packageId = 'pkg-mailer'

function context() {
	return {
		env: {
			APP_DB: personalOrgAccessD1(),
		} as unknown as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored('user-alice'),
				email: 'alice@example.com',
				displayName: 'Alice',
			},
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: null,
				storageId: null,
			},
		}),
	}
}

async function refresh(name: string) {
	return await runWithSecretAuthorityScope(new Set([packageId]), () =>
		runWithCurrentSecretAuthority(packageId, () =>
			integrationTokenRefreshCapability.handler({ name }, context()),
		),
	)
}

test('integrationTokenRefresh on a stamped package requires a declared integration', async () => {
	resolveCredential.mockResolvedValue({
		refreshed: true,
		refreshedAt: '2026-10-16T00:00:00.000Z',
		refreshTokenRotated: false,
	})
	const stamp = vi
		.spyOn(stampPresence, 'packageCarriesCredentialStamp')
		.mockResolvedValue(true)
	vi.spyOn(packageRepo, 'getSavedPackageByIdInAnyOrg').mockResolvedValue({
		id: packageId,
		userId: personIdFromStored('user-alice'),
		name: '@alice/mailer',
		kodyId: 'mailer',
		description: 'test',
		tags: [],
		searchText: null,
		sourceId: 'source',
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: true,
		isInternetVisible: false,
		lockedAt: null,
		createdAt: '2026-10-16T00:00:00.000Z',
		updatedAt: '2026-10-16T00:00:00.000Z',
	} as unknown as SavedPackageRecord)
	const needs = vi
		.spyOn(needsClosure, 'loadPublishedCredentialNeeds')
		.mockResolvedValue([])
	try {
		const denied = await refresh('github').then(
			() => null,
			(thrown: unknown) => thrown,
		)
		expect(denied).toMatchObject({
			code: 'credential_need_undeclared',
			key: 'github',
		})
		expect(resolveCredential).not.toHaveBeenCalled()

		needs.mockResolvedValue([
			{
				key: 'github',
				kind: 'oauth',
				provider: 'github',
				description: 'GitHub',
				multiple: false,
			},
		])
		await expect(refresh('github')).resolves.toMatchObject({
			ok: true,
			refreshed: true,
		})
		expect(resolveCredential).toHaveBeenCalledTimes(1)
	} finally {
		stamp.mockRestore()
		needs.mockRestore()
	}
})

test('refreshIntegrationTokenForPackage keeps the contextRuns deny gate for direct callers', async () => {
	resolveCredential.mockClear()
	const base = context()
	const denied = await refreshIntegrationTokenForPackage({
		env: base.env,
		callerContext: {
			...base.callerContext,
			request: deriveRequestContext({
				user: {
					userId: personIdFromStored('user-alice'),
					email: 'alice@example.com',
					username: 'alice',
					displayName: 'Alice',
				},
				source: {
					kind: 'execution-context-run',
					ecid: 'ec_1',
					runId: 'run_1',
				},
				contextRunByOperator: false,
			}),
		},
		packageStamp: claimedPackageStamp(packageId),
		name: 'github',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(String(denied)).toContain('context_run_denied')
	expect(resolveCredential).not.toHaveBeenCalled()
})
