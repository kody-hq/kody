/**
 * Host approval links open the org that owns the secret: a granted personal
 * Key used in a team run is approved in its owner's personal org.
 */
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { lookupSecretsThroughResolveSecret } from '#worker/test-support/secret-lookup.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { expandSecretPlaceholders } from '#mcp/fetch-gateway.ts'
import { parseHostApprovalRequiredBatchMessage } from '#mcp/secrets/errors.ts'
import * as secretService from '#mcp/secrets/service.ts'
import * as credentialResolver from '#worker/credentials/credential-resolver.ts'
import * as orgOwnerEmails from '#worker/orgs/owner-emails.ts'
import * as personalOrgIdModule from '#worker/orgs/personal-org-id.ts'
import {
	isActiveOrgQuery,
	isOrgBindingMembershipQuery,
	mockPersonalOrgBindingRow,
} from '#worker/test-support/org-binding-query.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

const env = {
	APP_DB: {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async run() {
							return { meta: { changes: 1 } }
						},
						async first() {
							if (isActiveOrgQuery(normalizedQuery)) return { ok: 1 }
							if (isOrgBindingMembershipQuery(normalizedQuery)) {
								return mockPersonalOrgBindingRow(String(params[1]), 'ada')
							}
							return null
						},
						async all() {
							return { results: [], meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database,
	...createInMemoryUserMeterEnv().env,
	COOKIE_SECRET: 'test-cookie-secret',
	SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	SENTRY_ENVIRONMENT: 'test',
} as unknown as Env

const props = {
	baseUrl: 'https://example.com',
	userId: ownerIdFromStored('user-123'),
	email: null,
	request: sessionRequestContext('user-123', 'ada'),
	storageContext: null,
}

type GatewayProps = Parameters<typeof expandSecretPlaceholders>[0]['props']

async function expand(request: Request, runProps: GatewayProps) {
	const { request: expanded, bodyFillDone } = await expandSecretPlaceholders({
		request,
		props: runProps,
		env,
	})
	await bodyFillDone
	return expanded
}

async function readHostApprovals(promise: Promise<unknown>) {
	const error = await promise.then(
		() => {
			throw new Error('Expected host approval error.')
		},
		(caught: unknown) => caught,
	)
	return parseHostApprovalRequiredBatchMessage(getErrorMessage(error))
}

function userSecret(
	value: string,
	allowedHosts: Array<string>,
): secretService.ResolvedSecret {
	return {
		credentialId: `cred-${value}`,
		found: true,
		value,
		scope: 'user',
		allowedHosts,
		allowedPackages: [],
		placement: null,
	}
}

beforeEach(() => {
	lookupSecretsThroughResolveSecret()
})

test('host approval for a granted personal Key in a team run links the owner personal org', async () => {
	const teamOrgId = ownerIdFromStored('team-org')
	const personalOrgId = ownerIdFromStored('ada-personal')
	const request = sessionRequestContext('user-123', 'ada')
	vi.spyOn(personalOrgIdModule, 'loadPersonalOrgIdForPerson').mockResolvedValue(
		personalOrgId,
	)
	vi.spyOn(orgOwnerEmails, 'loadOrgSlug').mockImplementation(async (_db, id) =>
		id === personalOrgId ? 'ada' : null,
	)
	vi.spyOn(credentialResolver, 'authorizeActorPersonalUse').mockResolvedValue()
	vi.spyOn(secretService, 'resolveSecret').mockImplementation(async (input) =>
		input.userId === personalOrgId
			? userSecret('secret-value', [])
			: {
					credentialId: null,
					found: false,
					value: null,
					scope: null,
					allowedHosts: [],
					allowedPackages: [],
					placement: null,
				},
	)
	const approvals = await readHostApprovals(
		expand(
			new Request('https://api.example.com/v1', {
				headers: {
					Authorization: 'Bearer {{secret:personalToken|scope=user}}',
				},
			}),
			{
				...props,
				userId: teamOrgId,
				request: { ...request, org: { id: teamOrgId, slug: 'team' } },
			},
		),
	)
	expect(approvals?.entries[0]?.approvalUrl).toBe(
		'https://example.com/connect/secrets?org=ada&name=personalToken&hosts=api.example.com',
	)
})
