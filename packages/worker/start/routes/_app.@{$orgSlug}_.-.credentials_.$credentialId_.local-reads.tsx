/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { LocalReadsApprovalPage } from '../pages/account-credential-local-reads.tsx'
import { loadLocalReadsApprovalPage } from '#start/server/credential-local-reads'
import { documentHead } from '../components/document-head.ts'

export const Route = createFileRoute(
	'/_app/@{$orgSlug}_/-/credentials_/$credentialId_/local-reads',
)({
	staticData: {
		navigation: { rail: 'workspace', item: 'credentials' },
		orgScope: { section: 'credentials' },
	},
	preload: false,
	staleTime: 0,
	gcTime: 0,
	loader: ({ params }) =>
		loadLocalReadsApprovalPage({
			data: { orgSlug: params.orgSlug, credentialId: params.credentialId },
		}),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const { approval, orgSlug } = Route.useLoaderData()
	return <LocalReadsApprovalPage approval={approval} orgSlug={orgSlug} />
}
