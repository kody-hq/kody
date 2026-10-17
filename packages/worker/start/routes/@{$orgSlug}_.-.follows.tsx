/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { staticDocumentHead } from '../components/document-head.ts'
import { orgFollowsQuery } from '../follows-query.ts'
import { OrgFollowsPage } from '../pages/org-follows.tsx'

export const Route = createFileRoute('/@{$orgSlug}_/-/follows')({
	staticData: {
		workspaceSwitch: { section: 'follows' },
		navigation: { rail: 'workspace', item: 'follows' },
		orgScope: { section: 'follows' },
	},
	loader: ({ context, params }) =>
		context.queryClient.ensureQueryData(
			orgFollowsQuery(context.actorKey, params.orgSlug),
		),
	head: (context) => staticDocumentHead('orgFollows')(context),
	component: Page,
})

function Page() {
	const { actorKey, pageLocation } = Route.useRouteContext()
	const { orgSlug } = Route.useParams()
	const { data } = useSuspenseQuery(orgFollowsQuery(actorKey, orgSlug))
	return (
		<OrgFollowsPage
			key={`${actorKey}:${orgSlug}`}
			data={data}
			currentHref={pageLocation.href}
		/>
	)
}
