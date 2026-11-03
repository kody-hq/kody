import type { YoutubeWatchLoaderData } from '#universal/loader-data.ts'
import { resolveYoutubeWatchAllowedVideoIds } from '#app/youtube-watch-allowlist.ts'

export async function loadYoutubeWatchLoaderData(input: {
	env: Env
	loadPlaylists?: boolean
}): Promise<YoutubeWatchLoaderData> {
	try {
		const allowedVideoIds = await resolveYoutubeWatchAllowedVideoIds({
			env: input.env,
			loadPlaylists: input.loadPlaylists,
		})
		return { allowedVideoIds }
	} catch (error) {
		console.error('youtube watch allowlist load failed', error)
		return { allowedVideoIds: [] }
	}
}
