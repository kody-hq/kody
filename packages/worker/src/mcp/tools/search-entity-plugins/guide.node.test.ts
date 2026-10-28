import { expect, test } from 'vitest'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { importGuideCatalog } from '#worker/guide-catalog-modules.ts'

import { searchUnified } from '../search-core.ts'
import { buildSearchableEntityDescriptors } from '../search-descriptors.ts'
import { formatEntityDetailMarkdown } from '../search-format-detail.ts'
import { formatSearchMarkdown } from '../search-format-list.ts'
import { toSlimStructuredMatches } from '../search-format-slim.ts'
import { guideSearchEntityPlugin } from './guide.ts'

const emptyOptionalRows = {
	packageRows: [],
	userSecretRows: [],
	userIntegrationRows: [],
}

const registry = { capabilitySpecs: {} } as never

function buildGuideCandidates(domain?: string) {
	return guideSearchEntityPlugin.buildCandidates!({
		env: {} as Env,
		query: 'package authoring',
		limit: 15,
		offline: true,
		registry,
		optionalRows: emptyOptionalRows,
		queryEmbedding: [],
		...(domain ? { domain } : {}),
	})
}

function rankGuides(query: string, includeAdminGuides?: boolean) {
	return searchUnified({
		env: {} as Env,
		query,
		limit: 10,
		registry,
		optionalRows: emptyOptionalRows,
		...(includeAdminGuides ? { includeAdminGuides } : {}),
	})
}

const { guides } = await importGuideCatalog()

function guideDetail(id: string, section?: string) {
	const guide = guides.find((entry) => entry.id === id)
	expect(guide).toBeDefined()
	return formatEntityDetailMarkdown({
		type: 'guide',
		id: guide!.id,
		title: guide!.title,
		description: guide!.summary,
		body: guide!.body,
		slug: guide!.slug,
		category: guide!.category,
		provider: guide!.provider,
		lastVerified: guide!.lastVerified,
		...(section ? { section } : {}),
	})
}

test('guide descriptors and candidates hide unadvertised and admin guides and respect domain scope', async () => {
	const descriptorIds = (includeAdminGuides?: boolean) =>
		guideSearchEntityPlugin.buildDescriptors!({
			registry,
			optionalRows: emptyOptionalRows,
			...(includeAdminGuides ? { includeAdminGuides } : {}),
		}).map((descriptor) => descriptor.id)
	const hiddenIds = ['admin_events']
	expect(descriptorIds().filter((id) => hiddenIds.includes(id))).toEqual([])
	expect(descriptorIds(true)).toContain('admin_events')

	const authoringCandidates = await buildGuideCandidates()
	const authoringIds = authoringCandidates.map((candidate) => candidate.id)
	expect(authoringIds).toContain('package_authoring')
	expect(authoringIds.filter((id) => hiddenIds.includes(id))).toEqual([])
	expect(await buildGuideCandidates('email')).toEqual([])
	expect(
		(await buildGuideCandidates(capabilityDomainNames.coding)).map(
			(candidate) => candidate.id,
		),
	).toContain('package_authoring')
	expect(
		buildSearchableEntityDescriptors({
			registry,
			optionalRows: emptyOptionalRows,
			domain: 'email',
		}).filter((descriptor) => descriptor.type === 'guide'),
	).toEqual([])

	const authoringMatch = authoringCandidates.find(
		(candidate) => candidate.id === 'package_authoring',
	)!.match
	expect(
		toSlimStructuredMatches({
			baseUrl: 'https://kody.codes',
			matches: [authoringMatch],
		}),
	).toEqual([
		expect.objectContaining({
			type: 'guide',
			id: 'package_authoring',
			entityRef: 'guide:package_authoring',
			usage: 'search({ entity: "guide:package_authoring" })',
		}),
	])
	expect(formatSearchMarkdown({ matches: [authoringMatch] })).toContain(
		'guide:package_authoring',
	)
})

test('searchUnified ranks advertised guides for doc queries and keeps them out of task and identity queries', async () => {
	const cases: Array<{
		query: string
		top?: string
		includes?: Array<string>
		excludes?: Array<string>
		includeAdminGuides?: boolean
	}> = [
		{ query: 'package authoring', top: 'package_authoring' },
		{ query: 'package apps', top: 'package_apps' },
		{
			query: 'package authoring lifecycle',
			includes: ['package_authoring', 'package_lifecycle'],
		},
		{ query: 'google guide', includes: ['provider_google'] },
		{ query: 'how kody works', includes: ['how_kody_works'] },
		{
			query: 'packages integrations mcp',
			includes: ['packages_integrations_mcp'],
		},
		{ query: 'google-calendar', excludes: ['provider_google'] },
		{ query: 'what is kody', excludes: ['first_win'] },
		{ query: 'admin events', excludes: ['admin_events'] },
		{
			query: 'admin events',
			includeAdminGuides: true,
			includes: ['admin_events'],
		},
	]
	for (const {
		query,
		top,
		includes = [],
		excludes = [],
		includeAdminGuides,
	} of cases) {
		const { matches } = await rankGuides(query, includeAdminGuides)
		const guideIds = matches.flatMap((match) =>
			match.type === 'guide' ? [match.id] : [],
		)
		expect({
			query,
			top: top ? matches[0] : undefined,
			missing: includes.filter((id) => !guideIds.includes(id)),
			leaked: guideIds.filter((id) => excludes.includes(id)),
		}).toEqual({
			query,
			top: top
				? expect.objectContaining({ type: 'guide', id: top })
				: undefined,
			missing: [],
			leaked: [],
		})
	}

	const taskQuery = await rankGuides('send an email to kent')
	expect(taskQuery.matches.filter((match) => match.type === 'guide')).toEqual(
		[],
	)
})

test('guide entity detail returns full bodies, a TOC for oversized guides, and focused sections', () => {
	const authoring = guides.find((guide) => guide.id === 'package_authoring')!
	const detail = guideDetail('package_authoring')
	expect(detail.markdown).toContain(authoring.body.slice(0, 40))
	expect(detail.structured).toMatchObject({
		kind: 'entity',
		type: 'guide',
		entityRef: 'guide:package_authoring',
		body: authoring.body,
		bodyMode: 'full',
		section: null,
	})

	const subscriptionsDetail = guideDetail('package_subscriptions')
	expect(subscriptionsDetail.structured).toMatchObject({
		type: 'guide',
		bodyMode: 'toc',
		section: null,
	})
	expect(subscriptionsDetail.markdown).toContain('## Contents')
	expect(subscriptionsDetail.markdown).toContain(
		'guide:package_subscriptions#repo.pushed',
	)
	expect(subscriptionsDetail.markdown).not.toContain('type RepoPushedEvent')

	const sectionCases = [
		{
			id: 'package_subscriptions',
			section: 'repo.pushed',
			contains: 'type RepoPushedEvent',
			omits: 'type FleetEntitlementCrossedEvent',
		},
		{
			id: 'package_apps',
			section: 'asset-urls',
			contains: 'packageContext.appBasePath',
			omits: 'Module.wasmBinary',
		},
	]
	for (const { id, section, contains, omits } of sectionCases) {
		const sectionDetail = guideDetail(id, section)
		expect(sectionDetail.structured).toMatchObject({
			type: 'guide',
			bodyMode: 'section',
			entityRef: `guide:${id}#${section}`,
			section: { slug: section },
		})
		expect(sectionDetail.markdown).toContain(contains)
		expect(sectionDetail.markdown).not.toContain(omits)
	}
})

test('guide entity detail focuses line anchors and rejects lines past the end', () => {
	const body = Array.from(
		{ length: 200 },
		(_, index) => `line ${String(index + 1)}`,
	).join('\n')
	const detail = {
		type: 'guide' as const,
		id: 'demo',
		title: 'Demo',
		description: 'Demo guide.',
		body,
		slug: 'demo',
		category: 'platform' as const,
		provider: null,
		lastVerified: null,
	}
	const line = formatEntityDetailMarkdown({ ...detail, section: 'L165' })
	expect(line.structured).toMatchObject({
		type: 'guide',
		bodyMode: 'lines',
		entityRef: 'guide:demo#L165',
		section: null,
	})
	expect(line.markdown).toContain('165|line 165')
	expect(line.markdown).not.toContain('144|line 144')

	expect(() =>
		formatEntityDetailMarkdown({ ...detail, section: 'L999' }),
	).toThrow(McpCallerError)
})

test.each(['executor credential', 'publisher and executor credential'])(
	'searching %s finds the credentials guide',
	async (query) => {
		const result = await rankGuides(query)
		expect(
			result.matches.some(
				(match) => match.type === 'guide' && match.id === 'credentials',
			),
		).toBe(true)
	},
)
