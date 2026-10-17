/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { organizationsQuery } from '../organizations-query.ts'
import { loadPageQuery } from '../page-query.ts'
import { CreateOrganizationPage } from '../pages/org-organizations.tsx'
export const Route = createFileRoute('/account_/organizations_/new')({
	staticData: {
		motionGroup: 'account',
		navigation: { rail: 'account', item: 'organizations' },
	},
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			organizationsQuery(context.actorKey, undefined),
			preload,
		),
	head: () => ({ meta: [{ title: 'Create organization' }] }),
	component: CreateOrganizationPage,
})
