export async function login(origin, email = 'me@kentcdodds.com', password = 'ilikecode') {
	const response = await fetch(new URL('/auth', origin), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password, mode: 'login' }),
	})
	const cookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
	if (!response.ok || !cookie) throw new Error(`login failed ${response.status}`)
	return cookie
}
