/** Canonical marketing origin for homepage JSON-LD (stable for CSP hashing). */
export const kodyCanonicalMarketingOrigin = 'https://kody.codes'

/**
 * Homepage JSON-LD (`SoftwareApplication`) for crawlers. Always points at
 * production so the inline script hash stays fixed under CSP. Facts only:
 * free plan is $0 USD; sameAs is the public GitHub repo (no invented profiles).
 */
export function buildHomeSoftwareApplicationJsonLd(
	origin: string = kodyCanonicalMarketingOrigin,
) {
	return {
		'@context': 'https://schema.org',
		'@type': 'SoftwareApplication',
		name: 'Kody',
		description:
			"Kody is Your agents' cloud for individuals and teams (orgs, teams, and grants). Connect the AI agent you already use over MCP for durable memory, credentials, packages, jobs, and apps.",
		url: origin,
		applicationCategory: 'DeveloperApplication',
		offers: {
			'@type': 'Offer',
			name: 'Free',
			price: '0',
			priceCurrency: 'USD',
			url: `${origin}/pricing`,
		},
		sameAs: ['https://github.com/kody-hq/kody'],
	}
}

/** Exact text of the homepage JSON-LD script body (must match SSR output). */
export function homeSoftwareApplicationJsonLdScriptText(
	origin: string = kodyCanonicalMarketingOrigin,
): string {
	return JSON.stringify(buildHomeSoftwareApplicationJsonLd(origin))
}
