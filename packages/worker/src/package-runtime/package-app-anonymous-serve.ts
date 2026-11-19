import type { RuntimePackageAppVisitor } from '@kody-internal/shared/runtime-worker.ts'

export function anonymousRefusalResponse(message: string) {
	return new Response(message, {
		status: 403,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

/**
 * Anonymous visitors run only a commit the owner approved for them (ADR
 * 0069); serve loads that commit, so the one refusal left is an app with no
 * approved commit at all.
 */
export function refuseUnapprovedAnonymousServe(input: {
	visitor: RuntimePackageAppVisitor | null
	approvedPublishedCommit: string | null | undefined
}) {
	if (input.visitor || input.approvedPublishedCommit) return null
	return anonymousRefusalResponse(
		'This version of the app is waiting for its owner to approve it for public visitors.',
	)
}
