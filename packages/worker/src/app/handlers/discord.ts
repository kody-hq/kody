import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadDiscordPageData } from '#app/discord-page-data.ts'

export async function loadDiscordPageForRequest(input: {
	env: Env
	request: Request
	prefetchFeatureFlags?: boolean
}) {
	const user = await readAuthenticatedAppUser(input.request, input.env, {
		prefetchFeatureFlags: input.prefetchFeatureFlags,
	})
	return loadDiscordPageData({
		env: input.env,
		userId: user?.userId,
	})
}
