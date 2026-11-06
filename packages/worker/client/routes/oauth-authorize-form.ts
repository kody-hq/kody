/**
 * Native consent-form defaults for `/oauth/authorize`.
 *
 * A method-less form GETs the pathname with field names only, which replaces
 * the OAuth query string with `kody_hp=` and surfaces a misleading
 * `client_id is required`. POST to pathname+search keeps those params, and the
 * hidden approve decision matches the submit button.
 */
export const oauthAuthorizeConsentDecision = 'approve' as const

export function oauthAuthorizeConsentFormAttrs(href: string) {
	const url = new URL(href, 'http://localhost')
	return {
		method: 'post' as const,
		action: `${url.pathname}${url.search}`,
	}
}

export type OAuthAuthorizeConsentOrg = {
	slug: string
	displayName: string | null
	role: string | null
}

export function readOAuthAuthorizeConsentOrgs(value: unknown) {
	if (!Array.isArray(value)) return []
	const orgs: Array<OAuthAuthorizeConsentOrg> = []
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') continue
		const slug = (entry as { slug?: unknown }).slug
		if (typeof slug !== 'string' || !slug.trim()) continue
		const displayName = (entry as { displayName?: unknown }).displayName
		const role = (entry as { role?: unknown }).role
		orgs.push({
			slug: slug.trim().toLowerCase(),
			displayName: typeof displayName === 'string' ? displayName : null,
			role: typeof role === 'string' ? role : null,
		})
	}
	return orgs
}

export function readOAuthAuthorizeSelectedOrgSlug(value: unknown) {
	if (typeof value !== 'string') return null
	const slug = value.trim().toLowerCase()
	return slug.length > 0 ? slug : null
}

export function oauthAuthorizeGrantHeading(selectedOrgSlug: string | null) {
	if (selectedOrgSlug)
		return `This agent gets full access in @${selectedOrgSlug}`
	return 'This agent gets full access'
}

export type OAuthAuthorizeOrgField =
	| { kind: 'hidden'; slug: string }
	| {
			kind: 'locked'
			slug: string
			reason: string
			options: ReadonlyArray<OAuthAuthorizeConsentOrg>
	  }
	| {
			kind: 'picker'
			selectedSlug: string | null
			options: ReadonlyArray<OAuthAuthorizeConsentOrg>
	  }
	| { kind: 'missing' }
	| { kind: 'pending' }

/** Default copy when a flow requires one org and the chooser must stay fixed. */
function oauthAuthorizeRequiredOrgReason(slug: string) {
	return `This connection was started for @${slug}. The organization cannot be changed here because the client already bound this sign-in to that workspace.`
}

export function oauthAuthorizeOrgField(input: {
	orgs: ReadonlyArray<OAuthAuthorizeConsentOrg>
	selectedOrgSlug: string | null
	signedIn: boolean
	/**
	 * When set, the flow must use this org. The chooser is disabled (or hidden
	 * for a sole org) so a person cannot pick a scope the approve path rejects.
	 */
	requiredOrgSlug?: string | null
	requiredReason?: string | null
}): OAuthAuthorizeOrgField {
	const required = input.requiredOrgSlug?.trim().toLowerCase() || null
	if (required) {
		const match = input.orgs.find((org) => org.slug === required)
		if (!match) {
			if (input.signedIn) return { kind: 'missing' }
			return { kind: 'pending' }
		}
		if (input.orgs.length === 1) return { kind: 'hidden', slug: match.slug }
		return {
			kind: 'locked',
			slug: match.slug,
			reason:
				input.requiredReason?.trim() ||
				oauthAuthorizeRequiredOrgReason(match.slug),
			options: input.orgs,
		}
	}
	if (input.orgs.length === 1) {
		const sole = input.orgs[0]
		if (!sole) return { kind: 'missing' }
		return { kind: 'hidden', slug: sole.slug }
	}
	if (input.orgs.length > 1) {
		return {
			kind: 'picker',
			selectedSlug: input.selectedOrgSlug,
			options: input.orgs,
		}
	}
	if (input.signedIn) return { kind: 'missing' }
	return { kind: 'pending' }
}

/** `hydrated` is post-hydrate interactivity, not `typeof document`. */
export function oauthAuthorizeActionsDisabled(input: {
	hydrated: boolean
	statusReady: boolean
	submitting: boolean
	sessionLoading: boolean
	needsEmailVerification: boolean
}) {
	return (
		!input.hydrated ||
		!input.statusReady ||
		input.submitting ||
		input.sessionLoading ||
		input.needsEmailVerification
	)
}

export function oauthAuthorizeApproveAriaLabel(input: {
	hydrated: boolean
	label: string
}) {
	if (input.hydrated) return undefined
	return `${input.label} (available after the page finishes loading)`
}

/** Standalone verify-email Deny is outside the consent form, so it cannot use `actionsDisabled`. */
export function oauthAuthorizeEmailVerificationDenyDisabled(input: {
	hydrated: boolean
	submitting: boolean
	sessionLoading: boolean
}) {
	return !input.hydrated || input.submitting || input.sessionLoading
}
