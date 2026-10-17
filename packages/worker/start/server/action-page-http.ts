// HEAD validates the link without consuming it or emitting a verification event.
export async function verifyEmailDestinationHead({
	request,
}: {
	request: Request
}) {
	const [{ env }, { getEnv }, { verifyEmailDestinationToken }] =
		await Promise.all([
			import('cloudflare:workers'),
			import('../../src/app/env.ts'),
			import('../../src/email/destination-verification.ts'),
		])
	const result = await verifyEmailDestinationToken({
		db: getEnv(env).APP_DB,
		token: new URL(request.url).searchParams.get('token'),
		consume: false,
	})
	return new Response(null, { status: result.ok ? 200 : 400 })
}

export async function unsubscribeTipsPost({ request }: { request: Request }) {
	const [
		{ env },
		{ getEnv },
		{ executeUnsubscribeTips },
		{ tipsUnsubscribeOneClickBody },
	] = await Promise.all([
		import('cloudflare:workers'),
		import('../../src/app/env.ts'),
		import('../../src/app/handlers/unsubscribe-tips.ts'),
		import('../../src/usage/tips-unsubscribe.ts'),
	])
	const body = (await request.text()).trim()
	if (body && body !== tipsUnsubscribeOneClickBody) {
		const { auditDatabaseFromEnv, getRequestIp, logAuditEvent } =
			await import('../../src/audit-log.ts')
		void logAuditEvent({
			db: auditDatabaseFromEnv(getEnv(env)),
			category: 'auth',
			action: 'tips_unsubscribe',
			result: 'failure',
			ip: getRequestIp(request) ?? undefined,
			path: '/unsubscribe/tips',
			reason: 'invalid_one_click_body',
		})
		return new Response('Invalid one-click unsubscribe body.', {
			status: 400,
			headers: { 'content-type': 'text/plain; charset=utf-8' },
		})
	}
	const result = await executeUnsubscribeTips({
		request,
		env: getEnv(env),
		token: new URL(request.url).searchParams.get('token'),
	})
	return new Response(result.ok ? result.message : result.error, {
		status: result.status ?? 200,
		headers: { 'content-type': 'text/plain; charset=utf-8' },
	})
}
