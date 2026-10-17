import { createElement, type ComponentType } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { Route as userRoute } from './routes/@{$orgSlug}_.-.secrets_.user.$secretName.tsx'
import { Route as packageRoute } from './routes/@{$orgSlug}_.-.secrets_.package.$packageId.$secretName.tsx'
import { Route as sessionRoute } from './routes/@{$orgSlug}_.-.secrets_.session.$sessionId.$secretName.tsx'
import { Route as approvalRoute } from './routes/@{$orgSlug}_.-.secrets_.approve.tsx'
import { secretsInput } from './secrets-input.ts'
import { renderStartPage } from './test-support/render-start-page.ts'
import type * as PageQueryModule from './page-query.ts'

vi.mock('./page-query.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PageQueryModule>()),
	usePageQuery: () => ({ data: { payload: {} } }),
}))
vi.mock('./pages/account-secrets.tsx', () => ({
	AccountSecretsPage: ({ packageApproval }: { packageApproval: boolean }) =>
		createElement(
			'div',
			null,
			packageApproval ? 'package approval' : 'secret detail',
		),
}))
afterEach(() => vi.restoreAllMocks())

test.each([
	[userRoute, { scope: 'user', name: 'TOKEN' }, '?package_id= package ', true],
	[userRoute, { scope: 'user', name: 'TOKEN' }, '?package_id=%20', false],
	[
		userRoute,
		{ scope: 'user', name: 'TOKEN' },
		'?allowed-host=example.com',
		false,
	],
	[
		packageRoute,
		{ scope: 'package', packageId: 'owner', name: 'TOKEN' },
		'?package_id=package',
		false,
	],
	[
		sessionRoute,
		{ scope: 'session', sessionId: 'session', name: 'TOKEN' },
		'?package_id=package',
		false,
	],
] as const)(
	'matched secret scope owns approval mode %#',
	async (route, selection, search, expected) => {
		vi.spyOn(route, 'useRouteContext').mockReturnValue({
			actorKey: 'owner',
			pageLocation: { href: '/@team/-/secrets/approve?package_id=wrong' },
			pageQueryInput: secretsInput('team', search, selection),
		} as ReturnType<typeof route.useRouteContext>)
		const html = await renderStartPage(
			createElement(route.options.component as ComponentType),
		)
		expect(html).toContain(expected ? 'package approval' : 'secret detail')
	},
)

test('explicit approval route stays in approval mode with missing package input for domain validation', async () => {
	vi.spyOn(approvalRoute, 'useRouteContext').mockReturnValue({
		pageLocation: { href: '/@team/-/secrets/user/TOKEN' },
	} as ReturnType<typeof approvalRoute.useRouteContext>)
	vi.spyOn(approvalRoute, 'useLoaderData').mockReturnValue({
		payload: {},
	} as ReturnType<typeof approvalRoute.useLoaderData>)
	const html = await renderStartPage(
		createElement(approvalRoute.options.component as ComponentType),
	)
	expect(html).toContain('package approval')
})
