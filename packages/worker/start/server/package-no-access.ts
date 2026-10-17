import {
	setResponseHeader,
	setResponseStatus,
} from '@tanstack/react-start/server'
import { type PackagePageAccess } from '#app/package-page.ts'
import { loadDocumentHead } from './document-head.ts'
export function packageNoAccessResult(
	page: Extract<PackagePageAccess, { kind: 'no_access' }>,
	pathname: string,
) {
	setResponseStatus(403)
	setResponseHeader('Cache-Control', 'private, no-store')
	setResponseHeader('Vary', 'Cookie')
	setResponseHeader('X-Robots-Tag', 'noindex, nofollow')
	return {
		...page,
		head: {
			...loadDocumentHead('communityPackage', pathname),
			title: "You don't have access",
		},
	}
}
