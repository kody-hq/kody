/**
 * Grammar for the per-app host label `{leaf}--{handle}` on the package-app
 * domain. Handles never contain `--` (see `dnsSafeUsernamePattern`) and leaves
 * never contain consecutive hyphens, so the first `--` splits the label
 * unambiguously.
 */

export const packageAppHostLabelSeparator = '--'

/** DNS label limit (RFC 1035). */
export const packageAppHostLabelMaxLength = 63

/**
 * `xn--{handle}` has the shape of a punycode A-label, which browsers and IDNA
 * libraries decode or reject.
 */
const packageAppHostLabelReservedLeaves: ReadonlySet<string> = new Set(['xn'])

export function isPackageAppHostLabelReservedPackageLeaf(leaf: string) {
	return packageAppHostLabelReservedLeaves.has(leaf.trim().toLowerCase())
}

export function packageAppHostLabelReservedPackageLeafMessage(leaf: string) {
	const normalized = leaf.trim().toLowerCase() || leaf
	return `Cannot create package: ${JSON.stringify(normalized)} is reserved because a package app host starting with "xn--" reads as an internationalized domain name. Choose a different package name leaf.`
}

export function buildPackageAppHostLabel(input: {
	leaf: string
	handle: string
}) {
	return `${input.leaf.trim().toLowerCase()}${packageAppHostLabelSeparator}${input.handle.trim().toLowerCase()}`
}

/**
 * Null when `{leaf}--{handle}` fits in one DNS label; otherwise copy naming
 * both lengths so the owner knows how much to shorten the package name.
 */
export function getPackageAppHostLabelLengthError(input: {
	leaf: string
	handle: string
}) {
	const label = buildPackageAppHostLabel(input)
	if (label.length <= packageAppHostLabelMaxLength) return null
	const maxLeafLength =
		packageAppHostLabelMaxLength -
		packageAppHostLabelSeparator.length -
		input.handle.trim().length
	return `Package app host "${label}" is ${label.length} characters, over the ${packageAppHostLabelMaxLength} character limit for a hostname label. For @${input.handle.trim().toLowerCase()}, a package with an app needs a name leaf of at most ${maxLeafLength} characters.`
}
