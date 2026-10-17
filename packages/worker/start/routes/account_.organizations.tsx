/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { organizationsQuery as pageQuery } from '../organizations-query.ts'
import { loadPageQuery, usePageQuery } from '../page-query.ts'
import { OrganizationsPage } from '../pages/org-organizations.tsx'

export const Route = createFileRoute('/account_/organizations')({
	staticData: {
		motionGroup: 'account',
		navigation: { rail: 'account', item: 'organizations' },
	},
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, undefined),
			preload,
		),
	head: () => ({ meta: [{ title: 'Organizations' }] }),
	component: Page,
})
function Page() {
	const { actorKey } = Route.useRouteContext()
	const { data } = usePageQuery(pageQuery(actorKey, undefined))
	return <OrganizationsPage data={data} />
}
