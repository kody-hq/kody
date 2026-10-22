/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { loadAccountPackageAlias } from '#start/server/package-alias'
import { NotFoundPage } from '../components/not-found-page.tsx'
export const Route = createFileRoute(
	'/_app/account_/packages/$packageId_/approve-publish',
)({
	loaderDeps: ({ search }) => search,
	loader: ({ abortController, params, location }) =>
		loadAccountPackageAlias({
			signal: abortController.signal,
			data: {
				packageId: params.packageId,
				search: location.searchStr,
				approval: 'publish',
			},
		}),
	notFoundComponent: NotFoundPage,
})
