import {
	orgResourcePath,
	type OrgOwnedAccountSection,
} from '#universal/org-pages.ts'

/**
 * Encode a stored resource name as one path segment, so a name like
 * `google.personal` survives route matching.
 */
function encodedPathSegment(segment: string) {
	return encodeURIComponent(segment).replaceAll('.', '%2E')
}

export function orgSectionRestPath(
	slug: string,
	section: OrgOwnedAccountSection,
	rest = '',
) {
	const suffix = rest
		.split('/')
		.filter(Boolean)
		.map((segment) => encodedPathSegment(segment))
		.join('/')
	return orgResourcePath(slug, section, suffix)
}
