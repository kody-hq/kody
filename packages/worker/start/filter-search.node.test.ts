import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	defaultParseSearch,
	stripSearchParams,
} from '@tanstack/react-router'
import { expect, test } from 'vitest'
import {
	collectionSearch,
	memoriesSearch,
	secretsSearch,
	textSearch,
} from './filter-search.ts'
import { adminUsersFilters, adminUsersSearch } from './admin-users-input.ts'
import { memoriesInput } from './memories-input.ts'

const validators = [
	collectionSearch,
	memoriesSearch,
	secretsSearch,
	textSearch,
	adminUsersSearch,
]

for (const validateSearch of validators) {
	test(`${validateSearch.name} preserves text through native Router navigation and bookmarked primitives`, async () => {
		const root = createRootRoute()
		const page = createRoute({
			getParentRoute: () => root,
			path: '/filters',
			validateSearch,
			search: {
				middlewares: [
					stripSearchParams<{
						q: string | undefined
						view?: string
						includeDeleted?: boolean
						pageSize?: number
					}>(
						validateSearch === collectionSearch
							? { view: 'active' }
							: validateSearch === memoriesSearch
								? { includeDeleted: false }
								: validateSearch === adminUsersSearch
									? { pageSize: 20 }
									: {},
					),
				],
			},
		})
		const router = createRouter({
			origin: 'https://kody.test',
			routeTree: root.addChildren([page]),
			history: createMemoryHistory({ initialEntries: ['/filters'] }),
			isServer: false,
		})
		await router.load()
		const queries = [
			'123',
			'true',
			'false',
			'null',
			'"hello"',
			'["123","true"]',
			'{ "value": true }',
			' 123 ',
		]
		for (const q of queries) {
			await router.navigate({
				to: '/filters',
				search: (previous: Record<string, unknown>) => ({ ...previous, q }),
			})
			const params = new URLSearchParams(router.state.location.searchStr)
			if (validateSearch === collectionSearch)
				expect(params.has('view')).toBe(false)
			if (validateSearch === memoriesSearch)
				expect(params.has('includeDeleted')).toBe(false)
			if (validateSearch === adminUsersSearch)
				expect(params.has('pageSize')).toBe(false)
			const parsed = router.state.location.search
			expect(validateSearch(parsed).q).toBe(q)
			expect(
				validateSearch(defaultParseSearch(router.state.location.searchStr)).q,
			).toBe(q)
			expect(memoriesInput('explicit-org', parsed).query).toBe(q.trim())
			expect(adminUsersFilters(parsed).query).toBe(q.trim())
		}
		if (
			validateSearch === collectionSearch ||
			validateSearch === memoriesSearch
		) {
			const key =
				validateSearch === collectionSearch ? 'view' : 'includeDeleted'
			const value = validateSearch === collectionSearch ? 'history' : true
			await router.navigate({
				to: '/filters',
				search: { q: '123', [key]: value },
			})
			expect(
				new URLSearchParams(router.state.location.searchStr).get(key),
			).toBe(String(value))
			expect(validateSearch(router.state.location.search).q).toBe('123')
		}

		if (validateSearch === adminUsersSearch) {
			await router.navigate({ to: '/filters', search: { pageSize: 50 } })
			expect(
				new URLSearchParams(router.state.location.searchStr).get('pageSize'),
			).toBe('50')
		}

		for (const q of ['123', 'true', 'false', 'null']) {
			await router.navigate({ href: `/filters?q=${q}` })
			expect(validateSearch(router.state.location.search).q).toBe(q)
		}
	})
}

test('memory filters keep boolean state and explicit resource scope while composing search edits', () => {
	const parsed = memoriesSearch(
		defaultParseSearch(
			'?q=%22123%22&includeDeleted=true&orgSlug=other&actorKey=other',
		),
	)
	expect(memoriesInput('explicit-org', parsed, 'explicit-memory')).toEqual({
		orgSlug: 'explicit-org',
		memoryId: 'explicit-memory',
		selected: undefined,
		query: '123',
		includeDeleted: true,
	})
	expect(memoriesSearch({ ...parsed, q: 'true' }).includeDeleted).toBe(true)
	expect(memoriesSearch({ ...parsed, includeDeleted: false }).q).toBe('123')
	expect(memoriesSearch({}).q).toBeUndefined()
})

test('text presentation validation leaves resource selection and protocol inputs unchanged', () => {
	const selected = { id: 'resource' }
	const search = {
		q: 123,
		selected,
		name: 'integration',
		package_id: 'package',
		scope: 'org',
	}
	expect(textSearch(search)).toEqual({ ...search, q: '123' })
	expect(textSearch(search)).toHaveProperty('selected', selected)
	expect(textSearch({ q: null }).q).toBe('null')
	expect(textSearch({}).q).toBeUndefined()
})
