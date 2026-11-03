import { handleNxCacheRequest } from './handle-request.ts'
import { createR2CacheStore } from './r2-store.ts'
import type { NxCacheEnv } from './nx-cache-types.ts'

export default {
	async fetch(request, env) {
		return handleNxCacheRequest(
			request,
			env,
			createR2CacheStore(env.CACHE_BUCKET),
		)
	},
} satisfies ExportedHandler<NxCacheEnv>
