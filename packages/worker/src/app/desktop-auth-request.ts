export type DesktopAuthRequest = {
	callback: string
	challenge: string
	state: string
	mode: 'login' | 'signup'
}
export function parseDesktopAuthRequest(input: unknown): DesktopAuthRequest {
	if (!input || typeof input !== 'object')
		throw new Error('Invalid desktop sign-in request.')
	const value = input as Record<string, unknown>
	if (
		typeof value.callback !== 'string' ||
		typeof value.challenge !== 'string' ||
		typeof value.state !== 'string'
	)
		throw new Error('Invalid desktop sign-in request.')
	const callback = new URL(value.callback)
	if (
		callback.protocol !== 'http:' ||
		callback.hostname !== '127.0.0.1' ||
		Number(callback.port) < 1024 ||
		callback.pathname !== '/kody/desktop/callback' ||
		callback.search ||
		callback.hash ||
		callback.username ||
		callback.password ||
		!/^[A-Za-z0-9_-]{43}$/.test(value.challenge) ||
		!/^[A-Za-z0-9_-]{43}$/.test(value.state)
	)
		throw new Error('Invalid desktop sign-in request.')
	return {
		callback: callback.href,
		challenge: value.challenge,
		state: value.state,
		mode: value.mode === 'signup' ? 'signup' : 'login',
	}
}
export async function desktopAuthHash(value: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value),
	)
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '')
}
export function desktopAuthSecret() {
	return btoa(
		String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
	)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '')
}
