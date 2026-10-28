export async function packageAppCookiePrefix(
	packageId: string,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(packageId),
	)
	const hash = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
	return `__kapp_${hash.slice(0, 12)}_`
}

export function isPackageAppOwnCookieName(name: string, prefix: string) {
	return (
		name.startsWith(prefix) ||
		name.startsWith(`__Host-${prefix}`) ||
		name.startsWith(`__Secure-${prefix}`)
	)
}

export function filterPackageAppRequestCookies(
	cookieHeader: string | null,
	prefix: string,
): string | null {
	if (!cookieHeader) return null
	const ownCookies = cookieHeader
		.split(';')
		.map((cookie) => cookie.trim())
		.filter((cookie) => {
			const name = cookie.split('=', 1)[0]?.trim() ?? ''
			return isPackageAppOwnCookieName(name, prefix)
		})
	return ownCookies.length > 0 ? ownCookies.join('; ') : null
}
