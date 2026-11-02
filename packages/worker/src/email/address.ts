const mailboxAddressPattern = /<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i
const strictAddrSpecPattern = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i
const strictHeaderMailboxPattern = /^(?:[^<>@]*<([^<>]*)>|([^<>\s]+))$/

export function normalizeEmailAddress(value: string) {
	const match = value.trim().match(mailboxAddressPattern)
	const address = match?.[1]?.trim().toLowerCase() ?? ''
	return address.length > 0 ? address : null
}

/**
 * Normalize a bare addr-spec (e.g. a parsed RFC 5322 mailbox address) without
 * extracting a substring. Anything that is not exactly one plain address,
 * such as a quoted local part that itself contains `@`, is null.
 */
export function normalizeAddrSpec(value: string | null | undefined) {
	const trimmed = value?.trim() ?? ''
	return strictAddrSpecPattern.test(trimmed) ? trimmed.toLowerCase() : null
}

/**
 * Strict counterpart of `normalizeEmailAddress` for one raw header mailbox
 * (`addr` or `Name <addr>`): the whole value must be one mailbox.
 */
export function normalizeHeaderMailbox(value: string) {
	const match = value.trim().match(strictHeaderMailboxPattern)
	return match ? normalizeAddrSpec(match[1] ?? match[2]) : null
}

export function requireNormalizedEmailAddress(value: string, label = 'Email') {
	const normalized = normalizeEmailAddress(value)
	if (!normalized) {
		throw new Error(`${label} must be a valid email address.`)
	}
	return normalized
}

export function getEmailDomain(address: string) {
	const normalized = requireNormalizedEmailAddress(address)
	const at = normalized.lastIndexOf('@')
	return normalized.slice(at + 1)
}

export function getEmailLocalPart(address: string) {
	const normalized = requireNormalizedEmailAddress(address)
	const at = normalized.lastIndexOf('@')
	return normalized.slice(0, at)
}

/**
 * Split an email local part into its base and RFC 5233 subaddress tag
 * (`user+tag` → base `user`, subaddress `tag`). The tag starts at the first
 * `+`; a missing or empty tag yields null.
 */
export function splitEmailLocalPart(localPart: string) {
	const plusIndex = localPart.indexOf('+')
	if (plusIndex === -1) {
		return { base: localPart, subaddress: null }
	}
	const base = localPart.slice(0, plusIndex)
	const subaddress = localPart.slice(plusIndex + 1)
	return { base, subaddress: subaddress.length > 0 ? subaddress : null }
}

export function normalizeEmailAddressList(values: ReadonlyArray<string>) {
	return Array.from(
		new Set(
			values
				.map((value) => normalizeEmailAddress(value))
				.filter((value): value is string => value !== null),
		),
	)
}

export function parseHeaderEmailAddressList(value: string | null | undefined) {
	if (!value) return []
	return normalizeEmailAddressList(value.split(','))
}

export function parseHeaderAddressList(value: string | null | undefined) {
	return parseHeaderEmailAddressList(value).map((address) => ({
		name: null,
		address,
	}))
}

export function normalizeSubject(subject: string | null | undefined) {
	const trimmed = subject?.trim() ?? ''
	return trimmed
		.replace(/^(?:(?:re|fw|fwd):\s*)+/i, '')
		.replace(/\s+/g, ' ')
		.toLowerCase()
}
