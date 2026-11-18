import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { toApiError } from '#worker/open-api/errors.ts'
import type { CapabilityContext } from '../types.ts'
import { kodyOfficialGuideCapability } from './kody-official-guide.ts'
import { guides } from '#worker/guides/catalog.ts'

const ctx: CapabilityContext = {
	env: {} as Env,
	callerContext: createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.example',
		user: null,
	}),
}

test('codingGuideGet serves public bundled guides and hides admin-only docs from anonymous callers', async () => {
	expect(guides.length).toBeGreaterThan(0)
	const publicGuides = guides.filter((guide) => !guide.adminOnly)
	expect(publicGuides.length).toBeLessThan(guides.length)
	for (const guide of publicGuides) {
		const result = await kodyOfficialGuideCapability.handler(
			{ guide: guide.id },
			ctx,
		)
		expect(result.title).toBe(guide.title)
		// Body is served without the frontmatter block. Oversized guides
		// return a contents index instead of the full authored markdown.
		expect(result.body.startsWith('#')).toBe(true)
		expect(result.body).not.toContain('\n---\nid:')
		expect(result.body.length).toBeGreaterThan(200)
		if (guide.body.length > 24_000) {
			expect(result.bodyMode).toBe('toc')
			expect(result.body).toContain('## Contents')
			expect(result.body).not.toBe(guide.body)
		} else {
			expect(result.bodyMode).toBe('full')
			expect(result.body).toBe(guide.body)
		}
	}

	const section = await kodyOfficialGuideCapability.handler(
		{ guide: 'package_subscriptions', section: 'repo.pushed' },
		ctx,
	)
	expect(section.bodyMode).toBe('section')
	expect(section.section?.slug).toBe('repo.pushed')
	expect(section.body).toContain('type RepoPushedEvent')
	expect(section.body).not.toContain('type FleetEntitlementCrossedEvent')

	const missingError = await kodyOfficialGuideCapability
		.handler({ guide: 'definitely_not_a_guide' }, ctx)
		.then(
			() => {
				throw new Error('expected missing guide to reject')
			},
			(error: unknown) => error,
		)
	const hiddenAdminError = await kodyOfficialGuideCapability
		.handler({ guide: 'admin_events' }, ctx)
		.then(
			() => {
				throw new Error('expected admin guide to reject for anonymous callers')
			},
			(error: unknown) => error,
		)
	expect(missingError).toBeInstanceOf(McpCallerError)
	expect(hiddenAdminError).toBeInstanceOf(McpCallerError)
	expect((missingError as Error).message).toBe(
		'Guide "definitely_not_a_guide" not found. Find guides with `search({ query: "<topic> guide" })`.',
	)
	expect((hiddenAdminError as Error).message).toBe(
		'Guide "admin_events" not found. Find guides with `search({ query: "<topic> guide" })`.',
	)
	expect(toApiError(missingError).status).toBe(404)
	await expect(
		kodyOfficialGuideCapability.handler({ guide: 'search' }, ctx),
	).rejects.toThrow('Did you mean `guide:search_and_execute`?')
	expect(
		(
			await kodyOfficialGuideCapability.handler(
				{ guide: 'package-authoring' },
				ctx,
			)
		).title,
	).toBe(guides.find((guide) => guide.id === 'package_authoring')?.title)
	expect(JSON.stringify(kodyOfficialGuideCapability.inputSchema)).not.toContain(
		'admin_events',
	)

	const adminResult = await kodyOfficialGuideCapability.handler(
		{ guide: 'admin_events' },
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://kody.example',
				user: {
					userId: personIdFromStored('admin-1'),
					email: 'admin@example.com',
					displayName: 'Admin',
					roles: ['admin'],
				},
			}),
		},
	)
	expect(adminResult.title).toBe('Admin events')
	expect(adminResult.body).toContain('fleet.entitlement.crossed')
})

test('codingGuideGet focuses line anchors and rejects lines past the end', async () => {
	const line = await kodyOfficialGuideCapability.handler(
		{ guide: 'package_authoring', section: 'L1' },
		ctx,
	)
	expect(line.bodyMode).toBe('lines')
	expect(line.section).toBeNull()
	expect(line.body).toContain('guide:package_authoring#L1')
	expect(line.body).toContain('1|')

	await expect(
		kodyOfficialGuideCapability.handler(
			{ guide: 'package_authoring', section: 'L999999' },
			ctx,
		),
	).rejects.toThrow(/past the end/)
	await expect(
		kodyOfficialGuideCapability.handler(
			{ guide: 'package_authoring', section: 'not-a-heading' },
			ctx,
		),
	).rejects.toThrow(McpCallerError)
})
