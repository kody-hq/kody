import { expect, test } from 'vitest'
import {
	buildSecretHostApprovalUrl,
	buildSecretHostBulkApprovalUrl,
	buildSecretHostBulkApprovalUrlIfNeeded,
} from './host-approval.ts'

test('host approval URLs use /connect/secrets and support multiple hosts', () => {
	expect(
		buildSecretHostApprovalUrl({
			baseUrl: 'https://example.com',
			orgSlug: null,
			name: 'cloudflareToken',
			scope: 'user',
			requestedHost: 'API.Cloudflare.com',
			storageContext: null,
		}),
	).toBe(
		'https://example.com/connect/secrets?name=cloudflareToken&hosts=api.cloudflare.com',
	)

	expect(
		buildSecretHostBulkApprovalUrl({
			baseUrl: 'https://example.com',
			orgSlug: null,
			names: ['accessToken', 'refreshToken'],
			hosts: ['api.example.com', 'oauth.example.com', 'api.example.com'],
		}),
	).toBe(
		'https://example.com/connect/secrets?names=accessToken%2CrefreshToken&hosts=api.example.com%2Coauth.example.com',
	)

	expect(
		buildSecretHostBulkApprovalUrl({
			baseUrl: 'https://example.com',
			orgSlug: null,
			names: ['signingSecret'],
			hosts: ['hooks.example.com'],
			scope: 'package',
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: 'pkg-1',
			},
		}),
	).toBe(
		'https://example.com/connect/secrets?name=signingSecret&hosts=hooks.example.com&scope=package&packageId=pkg-1',
	)

	expect(
		buildSecretHostBulkApprovalUrlIfNeeded({
			baseUrl: 'https://example.com',
			orgSlug: null,
			names: ['onlyOne'],
			hosts: ['api.example.com'],
		}),
	).toBeNull()

	expect(
		buildSecretHostBulkApprovalUrlIfNeeded({
			baseUrl: 'https://example.com',
			orgSlug: null,
			names: ['onlyOne'],
			hosts: ['api.example.com', 'oauth.example.com'],
		}),
	).toBe(
		'https://example.com/connect/secrets?name=onlyOne&hosts=api.example.com%2Coauth.example.com',
	)

	expect(
		buildSecretHostBulkApprovalUrl({
			baseUrl: 'https://example.com',
			orgSlug: null,
			names: ['openaiApiKey'],
			hosts: ['hooks.slack.com', 'api.ope', 'api.openai.com/v1'],
		}),
	).toBe(
		'https://example.com/connect/secrets?name=openaiApiKey&hosts=hooks.slack.com',
	)

	expect(() =>
		buildSecretHostBulkApprovalUrl({
			baseUrl: 'https://example.com',
			orgSlug: null,
			names: ['openaiApiKey'],
			hosts: ['api.ope', 'api.openai.com/v1'],
		}),
	).toThrow('At least one host is required for host approval.')

	expect(
		buildSecretHostApprovalUrl({
			baseUrl: 'https://example.com',
			orgSlug: null,
			name: 'localToken',
			scope: 'user',
			requestedHost: '::1',
			storageContext: null,
		}),
	).toBe(
		'https://example.com/connect/secrets?name=localToken&hosts=%5B%3A%3A1%5D',
	)
})

test('host approval URLs name the owning org so the page reads that org', () => {
	expect(
		buildSecretHostApprovalUrl({
			baseUrl: 'https://kody.codes',
			orgSlug: 'kody',
			name: 'rooms-wake-key-root',
			scope: 'user',
			requestedHost: 'kody.kody.run',
			storageContext: null,
		}),
	).toBe(
		'https://kody.codes/connect/secrets?org=kody&name=rooms-wake-key-root&hosts=kody.kody.run',
	)
	expect(
		buildSecretHostBulkApprovalUrlIfNeeded({
			baseUrl: 'https://kody.codes',
			orgSlug: 'kody',
			names: ['a', 'b'],
			hosts: ['api.example.com'],
		}),
	).toBe(
		'https://kody.codes/connect/secrets?org=kody&names=a%2Cb&hosts=api.example.com',
	)
})
