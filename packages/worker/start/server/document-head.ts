import { type AppLoaderData } from '#universal/loader-data.ts'
import {
	type DocumentHeadKey,
	absolutizeDocumentHead,
	resolveDocumentHead,
} from '#universal/document-head.ts'
import { getCanonicalAppBaseUrl } from '#worker/app-base-url.ts'
import { getEnv } from '#app/env.ts'
import { getRequest } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'

/** Called only inside server functions, using configured canonical origin. */
export function loadDocumentHead(
	key: DocumentHeadKey,
	pathname: string,
	data?: Partial<AppLoaderData>,
	search = '',
	params: Record<string, string | undefined> = {},
) {
	return absolutizeDocumentHead(
		resolveDocumentHead(key, pathname, data, search, params),
		getCanonicalAppBaseUrl({ env: getEnv(env), requestUrl: getRequest().url }),
	)
}
