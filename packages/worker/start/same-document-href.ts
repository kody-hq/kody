/** Same document: fragments never reach SSR, so compare hrefs without them. */
export function isSameDocumentHref(left: string, right: string) {
	const leftUrl = new URL(left, 'https://kody.local')
	const rightUrl = new URL(right, 'https://kody.local')
	leftUrl.hash = ''
	rightUrl.hash = ''
	return leftUrl.href === rightUrl.href
}
