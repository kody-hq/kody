/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { loadPublishReview } from '#start/server/package-review'
import { AccountPackageApprovePublishRoute } from '../pages/account-package-approve-publish.tsx'
import { documentHead } from '../components/document-head.ts'
export const Route = createFileRoute('/@{$username}_/$kodyId_/approve-publish')(
	{
		staticData: { navigation: { rail: 'workspace', item: 'packages' } },
		validateSearch: (search: Record<string, unknown>) => ({
			commit: typeof search.commit === 'string' ? search.commit : undefined,
		}),
		loaderDeps: ({ search }) => search,
		loader: ({ abortController, params, deps }) =>
			loadPublishReview({
				signal: abortController.signal,
				data: { ...params, ...deps },
			}),
		head: ({ loaderData }) => documentHead(loaderData?.head),
		component: Page,
	},
)
function Page() {
	const params = Route.useParams()
	return (
		<AccountPackageApprovePublishRoute
			key={`${params.username}/${params.kodyId}`}
			{...params}
			payload={Route.useLoaderData().payload}
		/>
	)
}
