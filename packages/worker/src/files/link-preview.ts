import { decodeHTML, decodeHTMLAttribute } from 'entities'
import { assertMcpEventCallbackUrl } from '../mcp/events/ssrf.ts'

const maxPreviewBytes = 128 * 1024

/** Read only a bounded public HTML response and extract text metadata. */
export async function fetchLinkPreviewTitle(input: string) {
	if (!Cloudflare.compatibilityFlags.global_fetch_strictly_public) return null
	try {
		const url = new URL(input)
		url.hash = ''
		const response = await fetch(assertMcpEventCallbackUrl(url.href), {
			headers: { accept: 'text/html' },
			redirect: 'manual',
			signal: AbortSignal.timeout(4000),
		})
		if (
			!response.ok ||
			!/^text\/html\b/i.test(response.headers.get('content-type') ?? '') ||
			!response.body
		) {
			await response.body?.cancel()
			return null
		}
		const reader = response.body.getReader()
		let remaining = maxPreviewBytes
		const bounded = new ReadableStream<Uint8Array>({
			async pull(controller) {
				const chunk = await reader.read()
				if (chunk.done) {
					controller.close()
					return
				}
				const value = chunk.value.subarray(0, remaining)
				controller.enqueue(value)
				remaining -= value.byteLength
				if (!remaining) {
					controller.close()
					await reader.cancel()
				}
			},
			cancel: (reason) => reader.cancel(reason),
		})
		let openGraph = ''
		let title = ''
		await new HTMLRewriter()
			.on('meta[property="og:title"]', {
				element(element) {
					openGraph ||= element.getAttribute('content') ?? ''
				},
			})
			.on('title', {
				text(chunk) {
					title += chunk.text
				},
			})
			.transform(
				new Response(bounded, { headers: { 'content-type': 'text/html' } }),
			)
			.body?.pipeTo(new WritableStream())
		const value =
			decodeHTMLAttribute(openGraph).trim() || decodeHTML(title).trim()
		return value.replace(/\s+/g, ' ').slice(0, 300) || null
	} catch {
		return null
	}
}
