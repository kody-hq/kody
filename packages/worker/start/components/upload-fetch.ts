/** Use Start's normal RPC encoding and authentication, with browser transfer events. */
export function uploadFetch(
	progress: (fraction: number) => void,
): typeof fetch {
	return async (input, init) => {
		const request = new Request(
			input instanceof Request
				? input
				: new URL(String(input), window.location.href),
			init,
		)
		const body = await request.blob()
		return new Promise<Response>((resolve, reject) => {
			const xhr = new XMLHttpRequest()
			xhr.open(request.method, request.url)
			xhr.withCredentials = request.credentials !== 'omit'
			request.headers.forEach((value, name) =>
				xhr.setRequestHeader(name, value),
			)
			xhr.responseType = 'arraybuffer'
			xhr.timeout = 180_000
			const abort = () => xhr.abort()
			const cleanup = () => request.signal.removeEventListener('abort', abort)
			xhr.upload.onprogress = (event) => {
				if (event.lengthComputable) progress(event.loaded / event.total)
			}
			xhr.onload = () => {
				cleanup()
				const headers = new Headers()
				for (const line of xhr
					.getAllResponseHeaders()
					.trim()
					.split(/[\r\n]+/)) {
					const colon = line.indexOf(':')
					if (colon > 0)
						headers.append(line.slice(0, colon), line.slice(colon + 1).trim())
				}
				resolve(
					new Response(xhr.response, {
						status: xhr.status,
						statusText: xhr.statusText,
						headers,
					}),
				)
			}
			xhr.onerror = () => {
				cleanup()
				reject(new Error('Connection lost. Try again.'))
			}
			xhr.ontimeout = () => {
				cleanup()
				reject(new Error('Upload timed out. Try again.'))
			}
			xhr.onabort = () => {
				cleanup()
				reject(new DOMException('Upload canceled', 'AbortError'))
			}
			request.signal.addEventListener('abort', abort, { once: true })
			if (request.signal.aborted) {
				cleanup()
				reject(new DOMException('Upload canceled', 'AbortError'))
				return
			}
			xhr.send(body)
		})
	}
}
