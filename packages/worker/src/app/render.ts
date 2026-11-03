import type { SafeHtml } from 'remix/html-template'
import { createHtmlResponse } from 'remix/response/html'
import { applyFirstPartySecurityHeaders } from '#app/security-headers.ts'

export function render(body: string | SafeHtml, init?: ResponseInit) {
	return applyFirstPartySecurityHeaders(createHtmlResponse(body, init))
}
