import { createServerFn } from '@tanstack/react-start'

export const loadDiscord = createServerFn({ method: 'GET' }).handler(
	async () => {
		const [
			{ env },
			{ getRequest },
			{ readAuthenticatedAppUser },
			{ loadDiscordPageData },
			{ getEnv },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('@tanstack/react-start/server'),
			import('../../src/app/authenticated-user.ts'),
			import('../../src/app/discord-page-data.ts'),
			import('../../src/app/env.ts'),
		])
		const bindings = getEnv(env)
		const user = await readAuthenticatedAppUser(getRequest(), bindings, {
			prefetchFeatureFlags: true,
		})
		return loadDiscordPageData({ env: bindings, userId: user?.userId })
	},
)
