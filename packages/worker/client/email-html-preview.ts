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

const droppedLinkAttributes = new Set(['target', 'rel'])
const whitespaceOrSlashPattern = /[\s/]/
const whitespacePattern = /\s/
const attributeNameEndPattern = /[\s/>=]/
const unquotedValueEndPattern = /[\s>]/
const tagNameCharPattern = /[A-Za-z0-9:-]/
/** HTML comment end: `-->` or `--!>` (comment end bang). */
const commentEndPattern = /--!?>/g
/** Elements whose contents are RAWTEXT (not tokenized as markup). */
const rawTextElements = new Set([
	'style',
	'textarea',
	'title',
	'xmp',
	'iframe',
	'noembed',
	'noframes',
])

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
 * Advance past one start tag's attributes the way the HTML tokenizer does
 * (quoted values may contain `>`). When `dropAttributes` is set, rebuild the
 * attribute text without those names; otherwise copy the tag unchanged.
 */
function readStartTagRest(
	html: string,
	from: number,
	dropAttributes: Set<string> | null,
) {
	let kept = ''
	let dropped = false
	let i = from
	while (i < html.length) {
		const segmentStart = i
		i = skipWhile(html, i, whitespaceOrSlashPattern)
		if (i >= html.length || html.charAt(i) === '>') {
			const tagEnd = Math.min(i + 1, html.length)
			if (dropAttributes === null) {
				return { kept: html.slice(from, tagEnd), end: tagEnd }
			}
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
		if (dropAttributes === null) continue
		if (dropAttributes.has(name)) {
			dropped = true
			continue
		}
		const segment = html.slice(segmentStart, i)
		kept += dropped && nameStart === segmentStart ? ` ${segment}` : segment
		dropped = false
	}
	if (dropAttributes === null) {
		return { kept: html.slice(from), end: html.length }
	}
	return { kept, end: html.length }
}

/**
 * Drop `target` and `rel` from real `<a>` / `<area>` start tags so the injected
 * `<base target="_blank">` applies and no `rel` can hand the new tab a
 * reference back to the preview. Walks markup like a tokenizer: HTML comments,
 * declarations, and other tags' attribute text are skipped so a comment or
 * quoted attribute cannot hide a real link from normalization.
 */
function normalizeEmailLinks(html: string) {
	let out = ''
	let i = 0
	while (i < html.length) {
		const lt = html.indexOf('<', i)
		if (lt < 0) {
			out += html.slice(i)
			break
		}
		out += html.slice(i, lt)

		if (html.startsWith('<!--', lt)) {
			// Abrupt empty comment `<!-->` / `<!---…>` plus normal `-->` / `--!>`.
			let to: number
			if (html.startsWith('>', lt + 4)) {
				to = lt + 5
			} else if (html.startsWith('->', lt + 4)) {
				to = lt + 6
			} else {
				commentEndPattern.lastIndex = lt + 4
				const match = commentEndPattern.exec(html)
				to = match ? match.index + match[0].length : html.length
			}
			out += html.slice(lt, to)
			i = to
			continue
		}

		if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
			const end = html.indexOf('>', lt + 2)
			const to = end < 0 ? html.length : end + 1
			out += html.slice(lt, to)
			i = to
			continue
		}

		if (html.startsWith('</', lt)) {
			const end = html.indexOf('>', lt + 2)
			const to = end < 0 ? html.length : end + 1
			out += html.slice(lt, to)
			i = to
			continue
		}

		if (!/[A-Za-z]/.test(html.charAt(lt + 1))) {
			out += '<'
			i = lt + 1
			continue
		}

		const nameEnd = skipWhile(html, lt + 1, tagNameCharPattern)
		const name = html.slice(lt + 1, nameEnd).toLowerCase()
		const drop = name === 'a' || name === 'area' ? droppedLinkAttributes : null
		const { kept, end } = readStartTagRest(html, nameEnd, drop)
		out += html.slice(lt, nameEnd) + kept
		i = end
		// RAWTEXT / plaintext: do not tokenize contents as tags (a fake `<a`
		// with an open quote would otherwise swallow a later real link).
		if (name === 'plaintext') {
			out += html.slice(i)
			break
		}
		if (rawTextElements.has(name)) {
			const close = new RegExp(`</${name}(?=[\\s/>])`, 'gi')
			close.lastIndex = i
			const match = close.exec(html)
			const to = match ? match.index : html.length
			out += html.slice(i, to)
			i = to
		}
	}
	return out
}

function isFullHtmlDocument(html: string) {
	const trimmed = html.trimStart()
	return fullHtmlDocumentPattern.test(trimmed) || htmlRootPattern.test(trimmed)
}

const leadingDoctypePattern = /^\s*<!DOCTYPE[^>]*>/i

/**
 * Put the head tags at the very start of the document (after a leading
 * doctype). The parser opens the implicit head for them and merges a later
 * `<html>` start tag's attributes, so they always land first in the real head
 * even if a `<head>` lookalike appears earlier in a comment or attribute.
 */
function injectPreviewHeadTags(html: string) {
	const doctype = leadingDoctypePattern.exec(html)?.[0] ?? ''
	return `${doctype}${previewHeadTags}${html.slice(doctype.length)}`
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
