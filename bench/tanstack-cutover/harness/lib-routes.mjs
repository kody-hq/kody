// Resolves the benchmark route list against a running variant (detail ids come from list pages).
export const publicRoutes = [
	['home', '/'], ['pricing', '/pricing'], ['docs', '/docs'], ['docs-deep', '/docs/how-kody-works'],
	['blog', '/blog'], ['blog-post', '/blog/early-kody-users'], ['community', '/community'],
	['profile', '/@user-me'], ['community-package', '/community/bench-listing-1'],
]
async function links(origin, cookie, path, re) {
	const html = await (await fetch(new URL(path, origin), { headers: { cookie } })).text()
	return [...new Set([...html.matchAll(/href="([^"#?]+)"/g)].map((m) => m[1]).filter((l) => re.test(l)))]
}
export async function resolveRoutes(origin, cookie) {
	const jobs = await links(origin, cookie, '/@user-me/-/jobs', /\/-\/jobs\/package-job/)
	const job1 = jobs.find((l) => l.endsWith('%3Abench-job-1'))
	const job2 = jobs.find((l) => l.endsWith('%3Abench-job-2'))
	const emails = await links(origin, cookie, '/@user-me/-/email', /\/-\/email\/email-inbound-message/)
	const creds = (await links(origin, cookie, '/@user-me/-/credentials', /\/-\/credentials\/[0-9a-f-]{36}$/))
	const mems = await links(origin, cookie, '/@user-me/-/memories', /\/-\/memories\/[0-9a-f-]{36}$/)
	const priv = [
		['account', '/account'], ['jobs', '/@user-me/-/jobs'], ['job-detail', job1],
		['email', '/@user-me/-/email'], ['email-message', emails[0]], ['credentials', '/@user-me/-/credentials'],
		['credential-detail', creds[0]], ['memories', '/@user-me/-/memories'], ['org-workspace', '/@bench-org/-/members'],
	]
	for (const [name, path] of priv) if (!path) throw new Error(`could not resolve ${name}`)
	return {
		routes: [...publicRoutes.map(([name, path]) => ({ name, path, auth: false })), ...priv.map(([name, path]) => ({ name, path, auth: true }))],
		extra: { job2, email2: emails[1], emails, creds, mems },
	}
}
