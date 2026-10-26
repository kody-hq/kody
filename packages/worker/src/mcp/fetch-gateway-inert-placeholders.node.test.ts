/**
 * Inert documentation vault placeholders must not resolve at the fetch
 * gateway (ordinary message bodies / execute-style params, and URL paths).
 */
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { expandSecretPlaceholders } from '#mcp/fetch-gateway.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import {
	isActiveOrgQuery,
	isOrgBindingMembershipQuery,
	mockPersonalOrgBindingRow,
} from '#worker/test-support/org-binding-query.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import * as providerService from '#mcp/secrets/secret-providers/service.ts'

const userMeter = createInMemoryUserMeterEnv()
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
							if (
								normalizedQuery.includes('where stable_user_id') &&
								params[0] !== 'user-123'
							) {
								throw new Error(
									'Account reverse-resolution must bind the acting userId.',
								)
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
	...userMeter.env,
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

const expand = async (request: Request) => {
	const { request: expanded, bodyFillDone } = await expandSecretPlaceholders({
		request,
		props,
		env,
	})
	if (expanded.body) {
		const peeked = expanded.clone()
		try {
			await peeked.arrayBuffer()
			await bodyFillDone
		} catch (error) {
			await bodyFillDone.catch(() => {})
			throw error
		}
	} else {
		await bodyFillDone
	}
	return expanded
}

beforeEach(() => {
	vi.restoreAllMocks()
})

test('fetch gateway leaves angle-bracket example vault placeholders untouched in ordinary body data', async () => {
	const resolveSpy = vi.spyOn(providerService, 'resolveProviderSecret')
	const example =
		'Post this docs line: use {{secret/bwvault:i/<item-uuid>/<field>}} or {{secret/<provider>:<ref>}}'
	const sent = await expand(
		new Request('https://api.example.com/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: example }),
		}),
	)
	expect(JSON.parse(await sent.text())).toEqual({ content: example })
	expect(resolveSpy).not.toHaveBeenCalled()
})

test('fetch gateway leaves percent-encoded angle-bracket example vault placeholders untouched in a URL path', async () => {
	const resolveSpy = vi.spyOn(providerService, 'resolveProviderSecret')
	// Path serialization encodes < > as %3C %3E; inert detection must still win.
	const examplePath =
		'/docs/%7B%7Bsecret/bwvault:i/%3Citem-uuid%3E/%3Cfield%3E%7D%7D'
	const sent = await expand(
		new Request(`https://api.example.com${examplePath}`),
	)
	expect(new URL(sent.url).pathname).toBe(examplePath)
	expect(resolveSpy).not.toHaveBeenCalled()
})

test('fetch gateway leaves metavariable {{secret/provider:ref}} untouched in an execute-style message param body', async () => {
	const resolveSpy = vi.spyOn(providerService, 'resolveProviderSecret')
	// Same shape as invoking a post-message export with content that documents
	// the vault grammar (no angle brackets): must not become a credential need.
	const params = {
		content: 'Example vault reference: {{secret/provider:ref}}',
	}
	const sent = await expand(
		new Request('https://discord.com/api/v10/channels/1/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(params),
		}),
	)
	expect(JSON.parse(await sent.text())).toEqual(params)
	expect(resolveSpy).not.toHaveBeenCalled()
})

test('fetch gateway still fills a live vault placeholder in a header', async () => {
	const providerRef = 'i/dddddddd-dddd-4ddd-8ddd-dddddddddddd/password'
	const canonical = `{{secret/1password:${providerRef}}}`
	vi.spyOn(providerService, 'getSecretProviderBinding').mockResolvedValue(null)
	const resolveSpy = vi
		.spyOn(providerService, 'resolveProviderSecret')
		.mockResolvedValue({
			provider: '1password',
			ref: providerRef,
			canonicalRef: providerRef,
			value: 'live-vault-password',
			hosts: ['api.example.com'],
		})
	const sent = await expand(
		new Request('https://api.example.com/v1', {
			headers: { Authorization: `Bearer ${canonical}` },
		}),
	)
	expect(sent.headers.get('Authorization')).toBe('Bearer live-vault-password')
	expect(resolveSpy).toHaveBeenCalledTimes(1)
})
