import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { type RepositoryOwnerOption } from '#universal/repository-create.ts'
import { loadCommunityInstallOrgs } from '#start/server/community-mutations'
import { useMatchedPageScope } from './use-matched-page-scope.ts'

export type CommunityInstallOrgPicker = {
	owners: Array<RepositoryOwnerOption>
	/** Slug of the picked org, or null for the personal org. */
	selected: string | null
	onSelect: (slug: string) => void
}

/** `?org=` from a search string, normalized the way the server reads it. */
function requestedInstallOrg(searchStr: string): string | null {
	const value = new URLSearchParams(searchStr).get('org')
	return value?.trim().replace(/^@/, '').toLowerCase() || null
}

/**
 * The org one-click install forks into. It lives in `?org=` so a link from an
 * org's Repositories page preselects it and the page data (install badges)
 * reloads for it. Personal is the default and drops the param.
 */
export function useCommunityInstallOrg(loggedIn: boolean): {
	org: string | null
	picker: CommunityInstallOrgPicker | null
} {
	const { actorKey, pageLocation } = useMatchedPageScope()
	const navigate = useNavigate()
	const requested = requestedInstallOrg(pageLocation.searchStr)
	const query = useQuery({
		queryKey: ['community-install-orgs', actorKey],
		queryFn: () => loadCommunityInstallOrgs({ data: {} }),
		enabled: loggedIn && actorKey != null,
		staleTime: 60_000,
		meta: { actorKey },
	})
	const owners = query.data?.owners ?? []
	const match = requested
		? owners.find((owner) => owner.slug.toLowerCase() === requested)
		: undefined
	// Until the options load, trust the URL; the server authorizes it anyway.
	const org = query.data
		? match && !match.personal
			? match.slug
			: null
		: requested
	if (owners.length < 2) return { org, picker: null }
	return {
		org,
		picker: {
			owners,
			selected: org,
			onSelect: (slug) => {
				const owner = owners.find((option) => option.slug === slug)
				const params = new URLSearchParams(pageLocation.searchStr)
				if (!owner || owner.personal) params.delete('org')
				else params.set('org', owner.slug)
				const search = params.toString()
				void navigate({
					to: `${pageLocation.pathname}${search ? `?${search}` : ''}`,
					replace: true,
					resetScroll: false,
				})
			},
		},
	}
}
