import { type OrgOwnedAccountSection } from '#universal/org-pages.ts'

export type OrgNavigationPolicy = { section?: OrgOwnedAccountSection }

declare module '@tanstack/router-core' {
	interface StaticDataRouteOption {
		orgScope?: OrgNavigationPolicy
	}
}

/** The matched route owns its authorization scope. Route names and URLs do not. */
export function orgNavigationScope(
	matches: ReadonlyArray<{
		staticData: { orgScope?: OrgNavigationPolicy }
		params: unknown
	}>,
) {
	for (const match of [...matches].reverse()) {
		const policy = match.staticData.orgScope
		if (!policy) continue
		if (
			!match.params ||
			typeof match.params !== 'object' ||
			!('orgSlug' in match.params)
		)
			continue
		const orgSlug = match.params.orgSlug
		if (typeof orgSlug !== 'string') continue
		return { orgSlug, section: policy.section }
	}
	return undefined
}
