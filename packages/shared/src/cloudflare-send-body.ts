/**
 * Cloudflare Email Sending REST (`POST .../email/sending/send`) uses snake_case
 * `reply_to`. The Workers binding uses camelCase `replyTo`. Internal outbound
 * mail stays `replyTo`; only this mapper changes the REST wire field. A
 * `fromName` becomes the named-address form `{ address, name }` on `from`.
 * @see https://developers.cloudflare.com/email-service/examples/email-sending/recipients/
 */
export function toCloudflareSendBody<
	T extends { from: string; fromName?: string | null; replyTo?: string | null },
>(
	outbound: T,
): Omit<T, 'replyTo' | 'fromName' | 'from'> & {
	from: string | { address: string; name: string }
	reply_to?: string
} {
	const { replyTo, fromName, from, ...rest } = outbound
	const name = fromName?.trim()
	const body = { ...rest, from: name ? { address: from, name } : from }
	const trimmed = replyTo?.trim()
	if (!trimmed) {
		return body
	}
	return { ...body, reply_to: trimmed }
}
