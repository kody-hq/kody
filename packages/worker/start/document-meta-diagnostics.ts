import { CANONICAL_ORIGIN_META_NAME } from '#universal/document-head-markers.ts'
import { documentActorMetaName } from './session-identity.ts'
import {
	documentCharset,
	documentViewport,
	documentThemeColors,
} from './document-shell-meta.ts'

type MetaCheck = {
	name: string
	selector: string
	index?: number
	attributes: Record<string, string>
}

/** Report attribute names and counts only, never document identity or contents. */
export function documentMetaDiagnostics(doc: Document, loaderData: unknown) {
	const checks: Array<MetaCheck> = [
		{
			name: 'charset',
			selector: 'meta[charset]',
			attributes: { charset: documentCharset },
		},
		{
			name: 'viewport',
			selector: 'meta[name="viewport"]',
			attributes: { content: documentViewport },
		},
		{
			name: 'theme-color-light',
			selector: 'meta[name="theme-color"]',
			index: 0,
			attributes: documentThemeColors.light,
		},
		{
			name: 'theme-color-dark',
			selector: 'meta[name="theme-color"]',
			index: 1,
			attributes: documentThemeColors.dark,
		},
	]
	if (loaderData && typeof loaderData === 'object') {
		if (
			'canonicalOrigin' in loaderData &&
			typeof loaderData.canonicalOrigin === 'string'
		) {
			checks.push({
				name: 'canonical-origin',
				selector: `meta[name="${CANONICAL_ORIGIN_META_NAME}"]`,
				attributes: { content: loaderData.canonicalOrigin },
			})
		}
		if (
			'actorKey' in loaderData &&
			(loaderData.actorKey === null || typeof loaderData.actorKey === 'string')
		) {
			checks.push({
				name: 'document-actor',
				selector: `meta[name="${documentActorMetaName}"]`,
				attributes: { content: JSON.stringify(loaderData.actorKey) },
			})
		}
	}
	return checks.map(({ name, selector, index = 0, attributes }) => {
		const matches = doc.head.querySelectorAll(selector)
		const element = matches[index]
		return {
			name,
			count: matches.length,
			index,
			differingAttributes: Object.entries(attributes)
				.filter(
					([attribute, expected]) =>
						element?.getAttribute(attribute) !== expected,
				)
				.map(([attribute]) => attribute)
				// Keep the leaf scalar at Sentry's default normalization depth.
				.join(','),
		}
	})
}
