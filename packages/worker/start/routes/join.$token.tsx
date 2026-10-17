import { createFileRoute } from '@tanstack/react-router'
import { resolveDocumentHead } from '#universal/document-head.ts'
import { loadOrgInvite } from '#start/server/org-management'
import { OrgInviteJoinPage } from '../pages/org-invite-join.tsx'
export const Route = createFileRoute('/join/$token')({
	preload: false,
	staleTime: 0,
	loader: ({ params }) => loadOrgInvite({ data: { token: params.token } }),
	head: ({ loaderData, params }) => ({
		meta: [
			{
				title: resolveDocumentHead(
					'orgInviteJoin',
					`/join/${encodeURIComponent(params.token)}`,
					{
						orgInviteJoin: loaderData,
					},
				).title,
			},
		],
	}),
	component: Page,
})
function Page() {
	const data = Route.useLoaderData()
	const { actorKey } = Route.useRouteContext()
	const { token } = Route.useParams()
	return <OrgInviteJoinPage key={`${actorKey}:${token}`} data={data} />
}
