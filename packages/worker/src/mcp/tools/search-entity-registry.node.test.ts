import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { type JoinedIntegration } from '#worker/integrations/types.ts'

import { buildSearchableEntityDescriptors } from './search-descriptors.ts'
import {
	type OptionalSearchRowsResult,
	type PackageSearchRow,
} from './search-types.ts'
import { understandSearchQuery } from './understand-search-query.ts'

function createPackageRow(): PackageSearchRow {
	return {
		record: {
			id: 'pkg-1',
			userId: ownerIdFromStored('user-1'),
			name: '@user/weather',
			kodyId: 'weather',
			description: 'Weather package',
			tags: ['weather'],
			searchText: null,
			sourceId: 'source-1',
			hasApp: false,
			hasSkills: false,
			hidden: false,
			isPrivate: false,
			isInternetVisible: false,
			lockedAt: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
		listingAhead: null,
		projection: {
			name: '@user/weather',
			kodyId: 'weather',
			description: 'Weather package',
			tags: ['weather'],
			searchText: null,
			hasApp: false,
			isPrivate: false,
			appEntry: null,
			exports: [],
			jobs: [],
			subscriptions: [],
			retrievers: [],
			webhooks: [],
		},
		readmeSnippet: null,
	}
}

function createJoinedIntegration(input: {
	userId?: string
	name: string
	description?: string
	scopes?: Array<string>
	requiredHosts?: Array<string>
	appSlug?: string
}): JoinedIntegration {
	const userId = input.userId ?? 'user-1'
	const appSlug = input.appSlug ?? input.name
	const now = '2026-01-01T00:00:00.000Z'
	return {
		lane: 'user',
		app: {
			userId,
			slug: appSlug,
			provider: appSlug.split('-')[0] ?? appSlug,
			label: null,
			clientId: `${input.name}_client_id`,
			hasClientSecret: true,
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			deviceAuthorizationUrl: null,
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: null,
			extraAuthorizeParams: {},
			createdAt: now,
			updatedAt: now,
		},
		connection: {
			userId,
			credentialId: 'cred-integration',
			name: input.name,
			appSlug,
			platformAppSlug: null,
			accountLabel: null,
			description: input.description ?? `${input.name} integration`,
			scopes: input.scopes ?? [],
			requiredHosts: input.requiredHosts ?? ['api.github.com'],
			usageMode: 'any' as const,
			allowedPackageIds: [],
			connectedAt: null,
			tokenRefreshedAt: null,
			createdAt: now,
			updatedAt: now,
		},
	}
}

test('descriptor seam follows registry order and preserves integration affinity', () => {
	const descriptors = buildSearchableEntityDescriptors({
		registry: {
			capabilitySpecs: {
				weather_search: {
					name: 'weather_search',
					domain: 'home',
					description: 'Search weather',
					keywords: ['forecast'],
					inputFields: ['city'],
					outputFields: ['forecast'],
				},
			},
		} as never,
		optionalRows: {
			packageRows: [createPackageRow()],
			userIntegrationRows: [
				createJoinedIntegration({
					name: 'github',
					description: 'GitHub integration',
				}),
			],
			userSecretRows: [
				{
					credentialId: 'cred-weather_api_key',
					name: 'weather_api_key',
					description: 'Weather API key',
					scope: 'user',
					packageId: null,
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
			],
		},
	})

	const types = [...new Set(descriptors.map((descriptor) => descriptor.type))]
	expect(types).toEqual([
		'capability',
		'guide',
		'package',
		'integration',
		'secret',
	])
	expect(descriptors[0]).toMatchObject({
		type: 'capability',
		id: 'weather_search',
	})
	expect(
		descriptors.some(
			(descriptor) =>
				descriptor.type === 'guide' && descriptor.id === 'package_authoring',
		),
	).toBe(true)
	expect(
		descriptors
			.filter((descriptor) => descriptor.type !== 'guide')
			.map((descriptor) => descriptor.id),
	).toEqual(['weather_search', 'weather', 'github', 'weather_api_key'])

	const userIntegrationRows = [
		createJoinedIntegration({
			name: 'github',
			description: 'GitHub integration',
		}),
	] satisfies OptionalSearchRowsResult['userIntegrationRows']
	const affinityDescriptors = buildSearchableEntityDescriptors({
		registry: { capabilitySpecs: {} } as never,
		optionalRows: {
			packageRows: [],
			userSecretRows: [],
			userIntegrationRows,
		},
		domain: 'email',
	})

	expect(affinityDescriptors.map((descriptor) => descriptor.type)).toEqual([
		'integration',
	])

	const intent = understandSearchQuery({
		query: 'github',
		entities: affinityDescriptors,
	})
	expect(intent.entities).toHaveLength(1)
	expect(intent.entities[0]).toMatchObject({
		type: 'integration',
		id: 'github',
	})
})
