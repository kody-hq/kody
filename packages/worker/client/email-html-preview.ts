const fullHtmlDocumentPattern = /^<!DOCTYPE\s+html\b/i
const htmlRootPattern = /^<html[\s>]/i

/**
 * `sandbox` value for the email HTML preview iframe. Popups are allowed (and
 * escape the sandbox) so links open in a normal new tab; scripts, forms and
 * same-origin access stay blocked.
 */
export const emailHtmlPreviewSandbox =
	'allow-popups allow-popups-to-escape-sandbox'

/**
 * Head tags for the preview document: no referrer on any request, and every
 * link opens in a new tab. A `_blank` target without an opener-granting `rel`
 * gets noopener semantics, and no-referrer covers noreferrer.
 */
const previewHeadTags =
	'<meta name="referrer" content="no-referrer"><base target="_blank">'

/** Strip script blocks from inbound email HTML before sandboxed preview. */
export function stripDangerousEmailHtml(html: string) {
	return html.replaceAll(
		/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
		'',
	)
}

const linkTagStartPattern = /<(?:a|area)(?=[\s/>])/gi
const droppedLinkAttributes = new Set(['target', 'rel'])
const whitespaceOrSlashPattern = /[\s/]/
const whitespacePattern = /\s/
const attributeNameEndPattern = /[\s/>=]/
const unquotedValueEndPattern = /[\s>]/

function skipWhile(html: string, index: number, pattern: RegExp) {
	let i = index
	while (i < html.length && pattern.test(html.charAt(i))) i++
	return i
}

function skipUntil(html: string, index: number, pattern: RegExp) {
	let i = index
	while (i < html.length && !pattern.test(html.charAt(i))) i++
	return i
}

/**
 * Read one start tag's attributes the way the HTML tokenizer does (quoted
 * values may contain `>`), dropping `target` and `rel`. Returns the kept tag
 * text after the tag name and the index just past the tag.
 */
function readLinkTagRest(html: string, from: number) {
	let kept = ''
	let dropped = false
	let i = from
	while (i < html.length) {
		const segmentStart = i
		i = skipWhile(html, i, whitespaceOrSlashPattern)
		if (i >= html.length || html.charAt(i) === '>') {
			const tagEnd = Math.min(i + 1, html.length)
			return { kept: kept + html.slice(segmentStart, tagEnd), end: tagEnd }
		}
		const nameStart = i
		i = skipUntil(html, i + 1, attributeNameEndPattern)
		const name = html.slice(nameStart, i).toLowerCase()
		const afterName = skipWhile(html, i, whitespacePattern)
		if (html.charAt(afterName) === '=') {
			const valueStart = skipWhile(html, afterName + 1, whitespacePattern)
			const quote = html.charAt(valueStart)
			if (quote === '"' || quote === "'") {
				const close = html.indexOf(quote, valueStart + 1)
				i = close < 0 ? html.length : close + 1
			} else {
				i = skipUntil(html, valueStart, unquotedValueEndPattern)
			}
		}
		if (droppedLinkAttributes.has(name)) {
			dropped = true
			continue
		}
		const segment = html.slice(segmentStart, i)
		kept += dropped && nameStart === segmentStart ? ` ${segment}` : segment
		dropped = false
	}
	return { kept, end: html.length }
}

/**
 * Drop `target` and `rel` from links so the injected `<base target="_blank">`
 * applies to every link (no in-frame or named-window navigation) and no `rel`
 * can hand the new tab a reference back to the preview.
 */
function normalizeEmailLinks(html: string) {
	let out = ''
	let last = 0
	for (const match of html.matchAll(linkTagStartPattern)) {
		if (match.index < last) continue
		const nameEnd = match.index + match[0].length
		const { kept, end } = readLinkTagRest(html, nameEnd)
		out += html.slice(last, nameEnd) + kept
		last = end
	}
	return out + html.slice(last)
}

function isFullHtmlDocument(html: string) {
	const trimmed = html.trimStart()
	return fullHtmlDocumentPattern.test(trimmed) || htmlRootPattern.test(trimmed)
}

function injectPreviewHeadTags(html: string) {
	if (/<head[\s>]/i.test(html)) {
		return html.replace(/<head([^>]*)>/i, `<head$1>${previewHeadTags}`)
	}
	if (/<html[\s>]/i.test(html)) {
		return html.replace(/<html([^>]*)>/i, `<html$1>${previewHeadTags}`)
	}
	if (/<!DOCTYPE[^>]*>/i.test(html)) {
		return html.replace(
			/<!DOCTYPE[^>]*>/i,
			(doctype) => `${doctype}${previewHeadTags}`,
		)
	}
	return `${previewHeadTags}${html}`
}

function wrapEmailHtmlFragment(html: string) {
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${previewHeadTags}
<style>
html, body { margin: 0; padding: 0; }
body {
	padding: 1rem;
	word-wrap: break-word;
	overflow-wrap: anywhere;
	color: #101010;
	font-family: ui-sans-serif, system-ui, sans-serif;
}
img { max-width: 100%; height: auto; }
table { max-width: 100%; }
</style>
</head>
<body>
${html}
</body>
</html>`
}

/** Build srcdoc HTML for a sandboxed admin email preview iframe. */
export function buildAdminEmailHtmlPreviewDocument(htmlBody: string) {
	const sanitized = normalizeEmailLinks(stripDangerousEmailHtml(htmlBody))
	if (isFullHtmlDocument(sanitized)) {
		return injectPreviewHeadTags(sanitized)
	}
	return wrapEmailHtmlFragment(sanitized)
}
