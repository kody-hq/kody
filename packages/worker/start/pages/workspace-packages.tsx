/** @jsxImportSource @emotion/react */
import { WorkspaceFileStatus } from './workspace-file-status.tsx'
import { isNotFound } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { loadOrgRepositories } from '#start/server/org-management'
import { colors } from '#universal/styles/tokens.ts'
import { createPageQuery } from '../page-query.ts'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { SiteLink } from '../components/site-link.tsx'

const packageQuery = createPageQuery(
	'loadOrgRepositories',
	loadOrgRepositories,
	{ freshAuthorization: true },
)
export const packagesDirectoryHref = (orgSlug: string) =>
	`/@${orgSlug}/-/files?collection=packages`
export function useWorkspacePackages(orgSlug: string, enabled: boolean) {
	const { actorKey } = useMatchedPageScope()
	return useQuery({
		...packageQuery(actorKey, { slug: orgSlug, query: '' }),
		enabled,
		refetchOnMount: 'always',
		refetchOnWindowFocus: true,
		refetchInterval: enabled ? 30_000 : false,
		retry: (count, error) => !isNotFound(error) && count < 3,
	})
}
export const repoWorkspaceHref = (
	orgSlug: string,
	repo: string,
	path = '',
	open = false,
) =>
	`${packagesDirectoryHref(orgSlug)}&${new URLSearchParams({
		repo,
		...(path ? { repoPath: path } : {}),
		...(open ? { repoOpen: 'true' } : {}),
	})}`

export function WorkspacePackages({
	orgSlug,
	query,
	search,
	activeRepo,
}: {
	orgSlug: string
	query: ReturnType<typeof useWorkspacePackages>
	search: string
	activeRepo?: string
}) {
	const items = (query.data?.packages ?? [])
		.filter(
			(item) =>
				item.canOpenDetail !== false &&
				item.name.toLowerCase().includes(search.trim().toLowerCase()),
		)
		.sort((a, b) => a.name.localeCompare(b.name))
	if (isNotFound(query.error)) return null
	if (query.isError)
		return (
			<WorkspaceFileStatus
				message="Could not load repositories."
				action={{ label: 'Try again', run: () => void query.refetch() }}
			/>
		)
	if (query.isPending) return <LoadingIndicator label="Loading repositories" />
	if (!items.length)
		return (
			<WorkspaceFileStatus
				message={
					search.trim() ? 'No matching repositories.' : 'No repositories yet.'
				}
			/>
		)
	return (
		<div css={{ display: 'grid', gap: 2, paddingLeft: 24 }}>
			{items.map((item) => (
				<SiteLink
					key={item.kodyId}
					href={repoWorkspaceHref(orgSlug, item.kodyId)}
					aria-current={item.kodyId === activeRepo ? 'page' : undefined}
					css={{
						padding: '5px 7px',
						fontSize: 12,
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
						color: colors.text,
						textDecoration: 'none',
						borderRadius: 5,
						background:
							item.kodyId === activeRepo ? colors.borderSubtle : undefined,
						'&:hover': { background: colors.borderSubtle },
					}}
				>
					{item.name}
				</SiteLink>
			))}
		</div>
	)
}
