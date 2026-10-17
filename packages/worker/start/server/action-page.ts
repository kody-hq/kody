import { createServerFn } from '@tanstack/react-start'

function tokenInput(data: {
	token: string | null
	redirectTo?: string | null
}) {
	if (
		!data ||
		(data.token !== null && typeof data.token !== 'string') ||
		(data.redirectTo != null && typeof data.redirectTo !== 'string')
	)
		throw new Error('Invalid token input')
	return { token: data.token, redirectTo: data.redirectTo }
}

async function tokenContext() {
	const [{ env }, { getRequest }, { getEnv }] = await Promise.all([
		import('cloudflare:workers'),
		import('@tanstack/react-start/server'),
		import('../../src/app/env.ts'),
	])
	return { request: getRequest(), env: getEnv(env) }
}

async function applyTokenHeaders({
	status,
	setCookie,
}: {
	status?: number
	setCookie?: string
}) {
	const { setResponseStatus, setResponseHeader } =
		await import('@tanstack/react-start/server')
	setResponseStatus(status ?? 200)
	if (setCookie) setResponseHeader('Set-Cookie', setCookie)
}

export const loadVerifyEmail = createServerFn({ method: 'GET' })
	.validator(tokenInput)
	.handler(async ({ data }) => {
		const { executeVerifyEmail } =
			await import('../../src/app/handlers/verify-email.ts')
		const { status, setCookie, ...outcome } = await executeVerifyEmail({
			...(await tokenContext()),
			...data,
		})
		await applyTokenHeaders({ status, setCookie })
		return outcome
	})

export const loadVerifyEmailChange = createServerFn({ method: 'GET' })
	.validator(tokenInput)
	.handler(async ({ data }) => {
		const { executeVerifyEmailChange } =
			await import('../../src/app/handlers/verify-email-change.ts')
		const { status, setCookie, ...outcome } = await executeVerifyEmailChange({
			...(await tokenContext()),
			...data,
		})
		await applyTokenHeaders({ status, setCookie })
		return outcome
	})

export const loadVerifyEmailClaimRelease = createServerFn({ method: 'GET' })
	.validator(tokenInput)
	.handler(async ({ data }) => {
		const { executeVerifyEmailClaimRelease } =
			await import('../../src/app/handlers/verify-email-claim-release.ts')
		const { status, setCookie, ...outcome } =
			await executeVerifyEmailClaimRelease({
				...(await tokenContext()),
				...data,
			})
		await applyTokenHeaders({ status, setCookie })
		return outcome
	})

export const loadVerifyEmailDestination = createServerFn({ method: 'GET' })
	.validator(tokenInput)
	.handler(async ({ data }) => {
		const { executeVerifyEmailDestination } =
			await import('../../src/app/handlers/verify-email-destination.ts')
		const { status, setCookie, ...outcome } =
			await executeVerifyEmailDestination({
				...(await tokenContext()),
				...data,
			})
		await applyTokenHeaders({ status, setCookie })
		return outcome
	})

export const loadUnsubscribeTips = createServerFn({ method: 'GET' })
	.validator(tokenInput)
	.handler(async ({ data }) => {
		const { executeUnsubscribeTips } =
			await import('../../src/app/handlers/unsubscribe-tips.ts')
		const { status, ...outcome } = await executeUnsubscribeTips({
			...(await tokenContext()),
			...data,
		})
		await applyTokenHeaders({ status })
		return outcome
	})
