export const htmlPreviewPath = (orgSlug: string) =>
	`/html-preview/${encodeURIComponent(orgSlug)}`

export const htmlPreviewCsp = [
	"default-src 'none'",
	"script-src 'unsafe-inline'",
	"style-src 'unsafe-inline'",
	'img-src data: blob:',
	'font-src data:',
	'media-src data: blob:',
	"connect-src 'none'",
	"frame-src 'none'",
	"worker-src 'none'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'self'",
	'sandbox allow-scripts',
].join('; ')

export const htmlPreviewPermissions =
	'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=(), fullscreen=(), payment=(), usb=(), serial=(), hid=()'

/** The wrapper contains no untrusted executable markup. Its frame-src policy also
 * constrains navigations of the inner frame, including window.location changes. */
export function htmlPreviewBootstrap(origin: string) {
	const trustedOrigin = JSON.stringify(origin).replaceAll('<', '\\u003c')
	return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0;background:white}</style></head><body><iframe title="Interactive HTML document" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><script>addEventListener('message', event => {if(event.source !== parent || event.origin !== ${trustedOrigin} || event.data?.type !== 'kody-html-preview' || typeof event.data.content !== 'string' || new TextEncoder().encode(event.data.content).byteLength > 65536)return;document.querySelector('iframe').srcdoc=event.data.content})</script></body></html>`
}
