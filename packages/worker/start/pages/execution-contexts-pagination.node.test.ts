import { createElement } from 'react'
import { expect, test } from 'vitest'
import type {
	ExecutionContextListItem,
	ExecutionContextsPageData,
} from '#universal/execution-contexts.ts'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { ExecutionContextsRoute } from './execution-contexts.tsx'

function context(index: number): ExecutionContextListItem {
	return {
		id: `ec_${index}`,
		name: `box-${String(index).padStart(2, '0')}`,
		ownerOrg: { id: 'org_1', slug: 'acme' },
		operator: { handle: 'sam' },
		isOperator: true,
		myPermissions: ['read', 'execute'],
		status: 'online',
		acceptingRuns: true,
		lastSeenAt: '2026-01-01T00:00:00.000Z',
		revokedAt: null,
		client: { name: '@kodycodes/cli', version: '1.0.0' },
		capabilities: { os: 'linux', maxConcurrent: 2, features: [] },
		grantSummary: {
			fs: 0,
			egress: { mode: 'public' },
			runtime: 'all',
			timeoutMs: 90_000,
		},
		optedIn: true,
		usable: true,
		chainUsage: { inMyChain: false, chainCount: 0 },
	}
}

async function render(input: {
	count: number
	cursor: string | null
	nextCursor: string | null
}) {
	const payload: ExecutionContextsPageData = {
		enabled: true,
		orgSlug: 'acme',
		personalOrg: false,
		teams: [],
		attachableOrgs: [],
		contexts: Array.from({ length: input.count }, (_, index) => context(index)),
		cursor: input.cursor,
		nextCursor: input.nextCursor,
		chain: { entries: [], strict: false, updatedAt: null, updatedBy: null },
		unutilized: null,
		selected: null,
		selectedMissing: false,
	}
	const href = input.cursor
		? `/@acme/-/execution-contexts?cursor=${input.cursor}`
		: '/@acme/-/execution-contexts'
	return await renderStartPage(
		createElement(ExecutionContextsRoute, {
			payload,
			selectedId: null,
			currentHref: href,
		}),
		href,
	)
}

test('a list that fits on one page renders no pagination controls', async () => {
	const html = await render({ count: 3, cursor: null, nextCursor: null })
	expect(html).toContain('box-02')
	expect(html).not.toContain('execution-contexts-pagination')
	expect(html).not.toContain('Next page')
	expect(html).not.toContain('First page')
})

test('the first of several pages links to the next page only', async () => {
	const html = await render({ count: 20, cursor: null, nextCursor: 'page2' })
	expect(html).toContain('execution-contexts-pagination')
	expect(html).toContain('href="/@acme/-/execution-contexts?cursor=page2"')
	expect(html).not.toContain('First page')
})

test('the last page links back to the first page only', async () => {
	const html = await render({ count: 5, cursor: 'page2', nextCursor: null })
	expect(html).toContain('First page')
	expect(html).toContain('href="/@acme/-/execution-contexts"')
	expect(html).not.toContain('Next page')
})
