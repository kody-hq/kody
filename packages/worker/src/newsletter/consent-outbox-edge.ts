import type * as Entrypoints from './entrypoints.ts'

// What account, admin, and guest flows import. The Effect slice loads on first
// use, so the Effect runtime stays off Worker startup for every other request.

export const whatsNewConsentOutboxQueueMessageKind = 'whats-new-consent-outbox'

/** Routes a queue body to the consent consumer; it decodes the full message. */
export function isWhatsNewConsentOutboxQueueBody(body: unknown) {
	return (
		typeof body === 'object' &&
		body !== null &&
		'kind' in body &&
		body.kind === whatsNewConsentOutboxQueueMessageKind
	)
}

export async function recordWhatsNewConsentChange(
	input: Parameters<typeof Entrypoints.recordWhatsNewConsentChange>[0],
) {
	const entrypoints = await import('./entrypoints.ts')
	await entrypoints.recordWhatsNewConsentChange(input)
}

export async function recordWhatsNewVerifiedAccount(
	input: Parameters<typeof Entrypoints.recordWhatsNewVerifiedAccount>[0],
) {
	const entrypoints = await import('./entrypoints.ts')
	await entrypoints.recordWhatsNewVerifiedAccount(input)
}
