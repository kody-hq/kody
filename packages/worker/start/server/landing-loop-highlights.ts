import { createServerFn } from '@tanstack/react-start'
export const loadLandingLoopHighlights = createServerFn({
	method: 'GET',
}).handler(async () => {
	const [{ env }, { getEnv }, { highlightWalkthrough }] = await Promise.all([
		import('cloudflare:workers'),
		import('../../src/app/env.ts'),
		import('../../src/app/handlers/docs.ts'),
	])
	return (await highlightWalkthrough(getEnv(env), 'how-kody-works')) ?? {}
})
