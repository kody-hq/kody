import { expect, test } from 'vitest'
import { CloudflareApiError } from '#worker/mcp/cloudflare/cloudflare-rest-client.ts'
import { CloudflareCustomHostnamesClient } from './cloudflare-custom-hostnames-client.ts'

const zoneId = 'packageappzoneid123'
const token = 'custom-hostnames-token'

function mockFetcher(
	handler: (request: Request) => Response | Promise<Response>,
): Fetcher {
	return {
		fetch(input: RequestInfo | URL, init?: RequestInit) {
			const request = new Request(input, init)
			return Promise.resolve(handler(request))
		},
		connect() {
			throw new Error('connect is not used')
		},
	} as Fetcher
}

test('custom hostname client adds, reads, and deletes with the dedicated token', async () => {
	const seen: Array<{
		method: string
		url: string
		authorization: string | null
		body: string
	}> = []
	const client = new CloudflareCustomHostnamesClient({
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: token,
		PACKAGE_APP_ZONE_ID: zoneId,
		fetcher: mockFetcher(async (request) => {
			seen.push({
				method: request.method,
				url: request.url,
				authorization: request.headers.get('authorization'),
				body: await request.text(),
			})
			return Response.json({
				success: true,
				result: {
					id: 'hostname-1',
					hostname: 'app.customer.example',
					status: request.method === 'DELETE' ? 'deleted' : 'pending',
					ownership_verification: {
						type: 'txt',
						name: '_cf-custom-hostname.app.customer.example',
						value: 'ownership-token',
					},
					ssl: {
						status: 'pending_validation',
						validation_records: [
							{
								txt_name: '_acme-challenge.app.customer.example',
								txt_value: 'ssl-token',
							},
						],
					},
				},
			})
		}),
	})

	const added = await client.addCustomHostname({
		hostname: 'App.Customer.Example',
		sslMethod: 'txt',
	})
	expect(added).toEqual({
		id: 'hostname-1',
		hostname: 'app.customer.example',
		hostnameStatus: 'pending',
		sslStatus: 'pending_validation',
		ownershipVerification: {
			type: 'txt',
			name: '_cf-custom-hostname.app.customer.example',
			value: 'ownership-token',
		},
		sslValidationRecords: [
			{
				type: 'txt',
				name: '_acme-challenge.app.customer.example',
				value: 'ssl-token',
			},
		],
		verificationErrors: [],
	})

	const fetched = await client.getCustomHostname({ id: 'hostname-1' })
	expect(fetched).toMatchObject({
		hostnameStatus: 'pending',
		ownershipVerification: { value: 'ownership-token' },
	})

	const deleted = await client.deleteCustomHostname({ id: 'hostname-1' })
	expect(deleted).toMatchObject({ hostnameStatus: 'deleted' })

	expect(
		seen.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`),
	).toEqual([
		`POST /client/v4/zones/${zoneId}/custom_hostnames`,
		`GET /client/v4/zones/${zoneId}/custom_hostnames/hostname-1`,
		`DELETE /client/v4/zones/${zoneId}/custom_hostnames/hostname-1`,
	])
	expect(seen.every((entry) => entry.authorization === `Bearer ${token}`)).toBe(
		true,
	)
	expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
		hostname: 'app.customer.example',
		ssl: { method: 'txt', type: 'dv' },
	})
})

test('custom hostname delete treats Cloudflare 404 as already gone', async () => {
	const client = new CloudflareCustomHostnamesClient({
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: token,
		PACKAGE_APP_ZONE_ID: zoneId,
		fetcher: mockFetcher(async () =>
			Response.json(
				{ success: false, errors: [{ message: 'not found', code: 1436 }] },
				{ status: 404 },
			),
		),
	})
	await expect(
		client.deleteCustomHostname({ id: 'missing-hostname' }),
	).resolves.toEqual({ alreadyGone: true })
	const bare = new CloudflareCustomHostnamesClient({
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: token,
		PACKAGE_APP_ZONE_ID: zoneId,
		fetcher: mockFetcher(
			async () => new Response('not found', { status: 404 }),
		),
	})
	await expect(
		bare.deleteCustomHostname({ id: 'missing-hostname' }),
	).resolves.toEqual({ alreadyGone: true })
})

test('custom hostname client falls back to HTTP ownership verification', async () => {
	const client = new CloudflareCustomHostnamesClient({
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: token,
		PACKAGE_APP_ZONE_ID: zoneId,
		fetcher: mockFetcher(async () =>
			Response.json({
				success: true,
				result: {
					id: 'hostname-http',
					hostname: 'app.customer.example',
					status: 'pending',
					ownership_verification_http: {
						http_url:
							'http://app.customer.example/.well-known/cf-custom-hostname-challenge/token',
						http_body: 'ownership-http-body',
					},
					ssl: { status: 'pending_validation' },
				},
			}),
		),
	})
	await expect(
		client.getCustomHostname({ id: 'hostname-http' }),
	).resolves.toMatchObject({
		ownershipVerification: {
			type: 'http',
			name: 'http://app.customer.example/.well-known/cf-custom-hostname-challenge/token',
			value: 'ownership-http-body',
		},
	})
})

test('custom hostname get requires Cloudflare missing-hostname code 1436', async () => {
	const client = new CloudflareCustomHostnamesClient({
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: token,
		PACKAGE_APP_ZONE_ID: zoneId,
		fetcher: mockFetcher(async () =>
			Response.json(
				{ success: false, errors: [{ message: 'not found', code: 1436 }] },
				{ status: 404 },
			),
		),
	})
	await expect(
		client.getCustomHostname({ id: 'missing-hostname' }),
	).resolves.toEqual({ alreadyGone: true })
})

test('custom hostname client refuses a missing token or zone', () => {
	expect(
		() =>
			new CloudflareCustomHostnamesClient({
				CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: '  ',
				PACKAGE_APP_ZONE_ID: zoneId,
			}),
	).toThrow(/CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN/)
	expect(
		() =>
			new CloudflareCustomHostnamesClient({
				CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: token,
				PACKAGE_APP_ZONE_ID: '',
			}),
	).toThrow(/PACKAGE_APP_ZONE_ID/)
})

test('custom hostname client rejects query and fragment delimiters in ids', async () => {
	const client = new CloudflareCustomHostnamesClient({
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: token,
		PACKAGE_APP_ZONE_ID: zoneId,
		fetcher: mockFetcher(async () => {
			throw new Error('must not fetch')
		}),
	})
	await expect(
		client.getCustomHostname({ id: 'hostname-1?x=1' }),
	).rejects.toThrow(/Custom hostname id is invalid/)
	await expect(
		client.deleteCustomHostname({ id: 'hostname-1#frag' }),
	).rejects.toThrow(/Custom hostname id is invalid/)
})

test('custom hostname get surfaces Cloudflare API errors', async () => {
	const client = new CloudflareCustomHostnamesClient({
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: token,
		PACKAGE_APP_ZONE_ID: zoneId,
		fetcher: mockFetcher(async () =>
			Response.json(
				{ success: false, errors: [{ message: 'zone locked' }] },
				{ status: 403 },
			),
		),
	})
	await expect(
		client.getCustomHostname({ id: 'hostname-1' }),
	).rejects.toBeInstanceOf(CloudflareApiError)
})
