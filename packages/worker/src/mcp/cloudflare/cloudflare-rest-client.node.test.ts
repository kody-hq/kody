import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import {
	createCloudflareRestClient,
	CloudflareRestClient,
} from './cloudflare-rest-client.ts'

type RecordedRequest = Pick<Request, 'method' | 'headers' | 'text'>

test('Cloudflare REST client refuses a non-HTTPS api.cloudflare.com base URL', () => {
	expect(
		() =>
			new CloudflareRestClient({
				apiToken: 'token',
				baseUrl: 'http://api.cloudflare.com',
			}),
	).toThrow(/must use HTTPS/)
	expect(
		() =>
			new CloudflareRestClient({
				apiToken: 'token',
				baseUrl: 'https://api.cloudflare.com',
			}),
	).not.toThrow()
	expect(
		() =>
			new CloudflareRestClient({
				apiToken: 'token',
				baseUrl: 'http://127.0.0.1:9028',
			}),
	).not.toThrow()
})

test('Cloudflare REST clients read mock responses, enforce API paths, and send JSON bodies', async () => {
	const token = 'cloudflare-client-env-token'
	const baseUrl = 'https://api.cloudflare.test'
	let accountsRequest = null as RecordedRequest | null
	let verifyRequest = null as RecordedRequest | null
	let patchRequest = null as RecordedRequest | null

	using _server = createMswNodeServer([
		http.get(`${baseUrl}/client/v4/accounts`, ({ request }) => {
			accountsRequest = request.clone()
			return HttpResponse.json(
				{
					success: true,
					result: [{ id: 'cf_account_mock_123' }],
				},
				{ headers: { 'cf-ray': 'accounts-ray-1' } },
			)
		}),
		http.get(`${baseUrl}/client/v4/user/tokens/verify`, ({ request }) => {
			verifyRequest = request.clone()
			return HttpResponse.json({
				success: true,
				result: { id: 'token_mock_123', status: 'active' },
			})
		}),
		http.patch(
			`${baseUrl}/client/v4/zones/example-zone-id/settings/always_online`,
			async ({ request }) => {
				patchRequest = request.clone()
				return HttpResponse.json({ success: true, result: null })
			},
		),
	])

	const directClient = new CloudflareRestClient({
		apiToken: token,
		baseUrl,
	})
	const accountsResponse = await directClient.rawRequest({
		method: 'GET',
		path: '/client/v4/accounts',
	})
	expect(accountsResponse.status).toBe(200)
	expect(accountsResponse.cfRay).toBe('accounts-ray-1')
	const accountsBody = accountsResponse.body as {
		success?: boolean
		result?: Array<{ id?: string }>
	}
	expect(accountsBody.success).toBe(true)
	expect(
		accountsBody.result?.some(
			(account) => account.id === 'cf_account_mock_123',
		),
	).toBe(true)
	expect(accountsRequest?.headers.get('authorization')).toBe(`Bearer ${token}`)

	const envClient = createCloudflareRestClient({
		CLOUDFLARE_API_TOKEN: token,
		CLOUDFLARE_API_BASE_URL: baseUrl,
	} as Pick<Env, 'CLOUDFLARE_API_TOKEN' | 'CLOUDFLARE_API_BASE_URL'>)
	const verifyResponse = await envClient.rawRequest({
		method: 'GET',
		path: '/client/v4/user/tokens/verify',
	})
	expect(verifyResponse.status).toBe(200)
	expect(verifyRequest?.headers.get('authorization')).toBe(`Bearer ${token}`)
	await expect(
		envClient.rawRequest({
			method: 'GET',
			path: '/zones',
		}),
	).rejects.toThrow('path must start with `/client/v4/`')

	const patchClient = new CloudflareRestClient({
		apiToken: 'patch-token',
		baseUrl,
	})
	const patchResponse = await patchClient.rawRequest({
		method: 'PATCH',
		path: '/client/v4/zones/example-zone-id/settings/always_online',
		body: { value: 'on' },
	})

	expect(patchResponse.status).toBe(200)
	expect(patchRequest).not.toBeNull()
	expect(patchRequest?.method).toBe('PATCH')
	expect(patchRequest?.headers.get('authorization')).toBe('Bearer patch-token')
	expect(patchRequest?.headers.get('content-type')).toBe('application/json')
	expect(await patchRequest?.text()).toBe('{"value":"on"}')
})
