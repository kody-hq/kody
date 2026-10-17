import { createElement, type ComponentType } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { Route as memoriesList } from './routes/@{$orgSlug}_.-.memories.tsx'
import { Route as memoriesDetail } from './routes/@{$orgSlug}_.-.memories_.$memoryId.tsx'
import type * as PageQueryModule from './page-query.ts'
import { renderStartPage } from './test-support/render-start-page.ts'

const state = vi.hoisted(() => ({ payload: {} as unknown }))
vi.mock('./page-query.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PageQueryModule>()),
	usePageQuery: () => ({ data: { payload: state.payload } }),
}))
afterEach(() => vi.restoreAllMocks())

for (const family of ['memories'] as const) {
	for (const detail of [false, true]) {
		test(`${family} ${detail ? 'path wins over selected search' : 'legacy selected search opens detail'}`, async () => {
			const route = detail ? memoriesDetail : memoriesList
			const id = 'literal%2Fpart'
			const href = `/@team/-/${family}${detail ? `/${id}` : ''}?selected=${detail ? 'other' : id}`
			// The committed match owns both the read input and rendered selection.
			// A different link location must not select another entity.
			vi.spyOn(route, 'useRouteContext').mockReturnValue({
				actorKey: 'owner',
				pageLocation: { href: `/@team/-/${family}/other` },
				pageQueryInput: {
					orgSlug: 'team',
					memoryId: detail ? id : undefined,
					selected: detail ? 'other' : ` ${id} `,
				},
			} as ReturnType<typeof route.useRouteContext>)
			const timestamp = '2026-01-01T00:00:00.000Z'
			const memory = {
				id,
				subject: 'Chosen memory',
				category: null,
				status: 'active',
				tags: [],
				summary: 'Chosen summary',
				details: 'Chosen content',
				sourceUris: [],
				dedupeKey: null,
				createdAt: timestamp,
				updatedAt: timestamp,
				lastAccessedAt: null,
				deletedAt: null,
			}
			state.payload = {
				ok: true,
				email: 'owner@example.com',
				username: 'owner',
				memories: [memory],
				selectedMemory: memory,
				query: '',
				includeDeleted: false,
				legacyReadOnly: false,
			}
			const html = await renderStartPage(
				createElement(route.options.component as ComponentType),
				href,
			)
			expect(html).toContain('Chosen content')
			expect(html).toContain('Chosen summary')
			expect(html).not.toContain('Memory not found')
		})
	}
}
