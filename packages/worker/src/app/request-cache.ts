import type { DataCacheLookup } from '#app/data-cache.ts'

type RequestMeta = {
	dataCacheLookup?: DataCacheLookup
}

const requestMetaStore = new WeakMap<Request, RequestMeta>()

function getRequestMeta(request: Request): RequestMeta {
	let meta = requestMetaStore.get(request)
	if (!meta) {
		meta = {}
		requestMetaStore.set(request, meta)
	}
	return meta
}

export function setRequestDataCacheLookup(
	request: Request,
	lookup: DataCacheLookup,
) {
	getRequestMeta(request).dataCacheLookup = lookup
}

export function getRequestDataCacheLookup(
	request: Request,
): DataCacheLookup | undefined {
	return requestMetaStore.get(request)?.dataCacheLookup
}
