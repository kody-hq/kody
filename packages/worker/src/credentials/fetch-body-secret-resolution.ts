/**
 * Non-blocking warning when a package fetch sends a body the gateway will
 * still scan for `{{secret:name}}`. Paired with
 * `packages/cli/src/fetch-body-secret-resolution.ts` — keep the two copies
 * identical. Publish and `kody dev check` both call this; neither fails.
 *
 * Clear cases only. A call is skipped when the init value is not an object
 * literal, or when a literal headers object sets `x-kody-secret-resolution` to
 * anything other than the literal `on`. A body that is a literal, or
 * `JSON.stringify` / `new URLSearchParams` of literal data, is author-written
 * and is not warned. Helpers that build headers in a variable, and header
 * spreads, still warn: the scanner cannot see `headers-only` on those bags.
 */

export const fetchBodySecretResolutionWarningLead =
	'WARNING: a fetch sends a body without x-kody-secret-resolution. The gateway fills {{secret:name}} anywhere in that body, so text this package did not write can fail with Secret "name" was not found, or a saved secret can be sent to a host the credential allows. Set x-kody-secret-resolution: headers-only on that fetch (headers still resolve). This does not block publish.'

const secretResolutionHeaderName = 'x-kody-secret-resolution'
const maxWarningSites = 8

export type FetchBodySecretResolutionHit = {
	line: number
}

export function findFetchBodiesMissingSecretResolution(
	source: string,
): Array<FetchBodySecretResolutionHit> {
	const hits: Array<FetchBodySecretResolutionHit> = []
	for (const call of findFetchLikeCalls(source)) {
		if (callSendsUnresolvedDynamicBody(call.args)) {
			hits.push({ line: lineAt(source, call.index) })
		}
	}
	return hits
}

export function formatFetchBodySecretResolutionWarning(
	hits: ReadonlyArray<{ path: string; line: number }>,
): string | null {
	if (hits.length === 0) return null
	const ordered = [...hits].sort((left, right) => {
		const byPath = left.path.localeCompare(right.path)
		return byPath === 0 ? left.line - right.line : byPath
	})
	const shown = ordered.slice(0, maxWarningSites)
	const extra = ordered.length - shown.length
	return [
		fetchBodySecretResolutionWarningLead,
		...shown.map((hit) => `- ${hit.path}:${hit.line}`),
		...(extra > 0 ? [`- ${extra} more`] : []),
	].join('\n')
}

type FetchLikeCall = {
	index: number
	args: Array<string>
}

function findFetchLikeCalls(source: string): Array<FetchLikeCall> {
	const calls: Array<FetchLikeCall> = []
	scanCode(source, 0, 'eof', calls)
	return calls
}

/**
 * Scan code, recording `fetch(` and `new Request(` calls. Template expressions
 * are scanned too. Returns the index to resume after a closing `}` when
 * `stop` is `brace`.
 */
function scanCode(
	source: string,
	start: number,
	stop: 'eof' | 'brace',
	calls: Array<FetchLikeCall>,
): number {
	let index = start
	let lastWord = ''
	let braceDepth = 0
	while (index < source.length) {
		const char = source[index]!
		if (isWhitespace(char)) {
			index += 1
			continue
		}
		if (char === '/' && source[index + 1] === '/') {
			index = skipLineComment(source, index)
			continue
		}
		if (char === '/' && source[index + 1] === '*') {
			index = skipBlockComment(source, index)
			continue
		}
		if (char === "'" || char === '"') {
			index = skipQuotedString(source, index)
			lastWord = ''
			continue
		}
		if (char === '`') {
			index = skipTemplate(source, index, calls)
			lastWord = ''
			continue
		}
		if (isIdentStart(char)) {
			const wordStart = index
			index += 1
			while (index < source.length && isIdentPart(source[index]!)) index += 1
			const word = source.slice(wordStart, index)
			const openParen = skipWhitespaceAndComments(source, index)
			const isFetch =
				word === 'fetch' && lastWord !== 'function' && lastWord !== 'async'
			const isRequest = word === 'Request' && lastWord === 'new'
			if ((isFetch || isRequest) && source[openParen] === '(') {
				const call = readCallArguments(source, openParen)
				if (call) calls.push({ index: wordStart, args: call.args })
			}
			lastWord = word
			continue
		}
		if (char === '{') {
			braceDepth += 1
			lastWord = ''
			index += 1
			continue
		}
		if (char === '}') {
			if (stop === 'brace' && braceDepth === 0) return index + 1
			braceDepth -= 1
			lastWord = ''
			index += 1
			continue
		}
		lastWord = ''
		index += 1
	}
	return index
}

function callSendsUnresolvedDynamicBody(args: Array<string>): boolean {
	const init = args[1]?.trim()
	if (init == null || !init.startsWith('{')) return false
	const properties = readObjectProperties(init)
	if (properties == null) return false
	// Last same-key wins, matching object-literal evaluation.
	const body = lastProperty(properties, 'body')
	if (body == null || body.spread || body.method) return false
	if (isStaticExpression(body.value)) return false
	const headers = lastProperty(properties, 'headers')
	if (headers == null) return true
	if (headers.spread || headers.method) return true
	return headersLeaveBodyResolutionOn(headers.value)
}

/**
 * True when this headers value still fills the body. A non-literal headers
 * value (variable / helper) or a spread warns: we cannot prove headers-only.
 * A literal bag that sets the resolution mode to something other than `on`
 * opts out.
 */
function headersLeaveBodyResolutionOn(headersValue: string): boolean {
	const text = headersValue.trim()
	if (!text.startsWith('{')) return true
	const properties = readObjectProperties(text)
	if (properties == null) return true
	if (properties.some((property) => property.spread)) return true
	const resolution = lastProperty(properties, secretResolutionHeaderName, {
		caseInsensitive: true,
	})
	if (resolution == null || resolution.method) return true
	const mode = staticStringValue(resolution.value)
	if (mode == null) return false
	return mode === 'on'
}

function lastProperty(
	properties: ReadonlyArray<ObjectProperty>,
	key: string,
	options?: { caseInsensitive?: boolean },
): ObjectProperty | undefined {
	const needle = options?.caseInsensitive ? key.toLowerCase() : key
	for (let index = properties.length - 1; index >= 0; index -= 1) {
		const property = properties[index]!
		const name = property.key
		if (name == null) continue
		const match = options?.caseInsensitive ? name.toLowerCase() : name
		if (match === needle) return property
	}
	return undefined
}

type ObjectProperty = {
	key: string | null
	value: string
	spread: boolean
	method: boolean
}

function readObjectProperties(source: string): Array<ObjectProperty> | null {
	const text = source.trim()
	if (!text.startsWith('{')) return null
	const properties: Array<ObjectProperty> = []
	let index = 1
	while (index < text.length) {
		index = skipWhitespaceAndComments(text, index)
		if (index >= text.length) return null
		if (text[index] === '}') return properties
		if (text[index] === ',') {
			index += 1
			continue
		}
		if (text.startsWith('...', index)) {
			const spread = readExpression(text, index + 3)
			if (spread == null) return null
			properties.push({
				key: null,
				value: spread.text,
				spread: true,
				method: false,
			})
			index = spread.end
			continue
		}
		const key = readPropertyKey(text, index)
		if (key == null) return null
		index = skipWhitespaceAndComments(text, key.end)
		if (text[index] === '(' || text.startsWith('async ', key.start)) {
			const method = skipMethod(text, index)
			if (method == null) return null
			properties.push({
				key: key.name,
				value: '',
				spread: false,
				method: true,
			})
			index = method
			continue
		}
		if (text[index] !== ':') {
			properties.push({
				key: key.name,
				value: key.raw,
				spread: false,
				method: false,
			})
			continue
		}
		const value = readExpression(text, index + 1)
		if (value == null) return null
		properties.push({
			key: key.name,
			value: value.text,
			spread: false,
			method: false,
		})
		index = value.end
	}
	return null
}

function readPropertyKey(
	source: string,
	start: number,
): { name: string | null; raw: string; start: number; end: number } | null {
	const index = skipWhitespaceAndComments(source, start)
	const char = source[index]
	if (char === "'" || char === '"') {
		const end = skipQuotedString(source, index)
		const raw = source.slice(index, end)
		return { name: staticStringValue(raw), raw, start: index, end }
	}
	if (char === '[') {
		const computed = readBalanced(source, index, '[', ']')
		if (computed == null) return null
		return { name: null, raw: computed.text, start: index, end: computed.end }
	}
	if (char != null && isIdentStart(char)) {
		let end = index + 1
		while (end < source.length && isIdentPart(source[end]!)) end += 1
		const raw = source.slice(index, end)
		return { name: raw, raw, start: index, end }
	}
	return null
}

function readExpression(
	source: string,
	start: number,
): { text: string; end: number } | null {
	const index = skipWhitespaceAndComments(source, start)
	const balanced = readUntilSeparator(source, index)
	if (balanced == null) return null
	return { text: source.slice(index, balanced), end: balanced }
}

/** End index of an expression, stopping before a top-level comma or `}`. */
function readUntilSeparator(source: string, start: number): number | null {
	let index = start
	let paren = 0
	let brace = 0
	let bracket = 0
	while (index < source.length) {
		const char = source[index]!
		if (char === '/' && source[index + 1] === '/') {
			index = skipLineComment(source, index)
			continue
		}
		if (char === '/' && source[index + 1] === '*') {
			index = skipBlockComment(source, index)
			continue
		}
		if (char === "'" || char === '"') {
			index = skipQuotedString(source, index)
			continue
		}
		if (char === '`') {
			index = skipTemplate(source, index, [])
			continue
		}
		if (char === '(') paren += 1
		else if (char === ')') {
			if (paren === 0) return index
			paren -= 1
		} else if (char === '{') brace += 1
		else if (char === '}') {
			if (brace === 0 && paren === 0 && bracket === 0) return index
			brace -= 1
		} else if (char === '[') bracket += 1
		else if (char === ']') {
			// End of an array element list (same as `}` for objects).
			if (bracket === 0) return index
			bracket -= 1
		} else if (char === ',' && paren === 0 && brace === 0 && bracket === 0) {
			return index
		}
		index += 1
	}
	return null
}

function skipMethod(source: string, openParen: number): number | null {
	const params = readBalanced(source, openParen, '(', ')')
	if (params == null) return null
	const bodyAt = skipWhitespaceAndComments(source, params.end)
	if (source[bodyAt] !== '{') return null
	const body = readBalanced(source, bodyAt, '{', '}')
	return body?.end ?? null
}

function readCallArguments(
	source: string,
	openParen: number,
): { args: Array<string> } | null {
	const args: Array<string> = []
	let index = openParen + 1
	let argStart = index
	let paren = 1
	let brace = 0
	let bracket = 0
	while (index < source.length) {
		const char = source[index]!
		if (char === '/' && source[index + 1] === '/') {
			index = skipLineComment(source, index)
			continue
		}
		if (char === '/' && source[index + 1] === '*') {
			index = skipBlockComment(source, index)
			continue
		}
		if (char === "'" || char === '"') {
			index = skipQuotedString(source, index)
			continue
		}
		if (char === '`') {
			index = skipTemplate(source, index, [])
			continue
		}
		if (char === '(') paren += 1
		else if (char === ')') {
			paren -= 1
			if (paren === 0) {
				args.push(source.slice(argStart, index))
				return { args }
			}
		} else if (char === '{') brace += 1
		else if (char === '}') brace -= 1
		else if (char === '[') bracket += 1
		else if (char === ']') bracket -= 1
		else if (char === ',' && paren === 1 && brace === 0 && bracket === 0) {
			args.push(source.slice(argStart, index))
			argStart = index + 1
		}
		index += 1
	}
	return null
}

function readBalanced(
	source: string,
	openIndex: number,
	open: string,
	close: string,
): { text: string; end: number } | null {
	let depth = 0
	let index = openIndex
	while (index < source.length) {
		const char = source[index]!
		if (char === '/' && source[index + 1] === '/') {
			index = skipLineComment(source, index)
			continue
		}
		if (char === '/' && source[index + 1] === '*') {
			index = skipBlockComment(source, index)
			continue
		}
		if (char === "'" || char === '"') {
			index = skipQuotedString(source, index)
			continue
		}
		if (char === '`') {
			index = skipTemplate(source, index, [])
			continue
		}
		if (char === open) depth += 1
		else if (char === close) {
			depth -= 1
			if (depth === 0) {
				return { text: source.slice(openIndex, index + 1), end: index + 1 }
			}
		}
		index += 1
	}
	return null
}

function isStaticExpression(expression: string): boolean {
	const text = expression.trim()
	if (isLiteral(text)) return true
	const stringify = matchCallee(text, 'JSON.stringify')
	if (stringify != null) {
		const data = stringify.args[0]
		return (
			data != null &&
			stringify.args.slice(1).every((arg) => isLiteral(arg.trim())) &&
			isStaticData(data)
		)
	}
	const params = matchNewCallee(text, 'URLSearchParams')
	if (params != null) {
		if (params.args.length === 0) return true
		const data = params.args[0]
		return data != null && params.args.length === 1 && isStaticData(data)
	}
	return false
}

function isStaticData(expression: string): boolean {
	const text = expression.trim()
	if (isLiteral(text)) return true
	if (text.startsWith('{')) {
		const closed = readBalanced(text, 0, '{', '}')
		if (closed == null || closed.end !== text.length) return false
		const properties = readObjectProperties(text)
		if (properties == null) return false
		return properties.every(
			(property) =>
				!property.spread &&
				!property.method &&
				property.key != null &&
				isStaticData(property.value),
		)
	}
	if (text.startsWith('[')) {
		const closed = readBalanced(text, 0, '[', ']')
		if (closed == null || closed.end !== text.length) return false
		const elements = readArrayElements(text)
		if (elements == null) return false
		return elements.every((element) => isStaticData(element))
	}
	return false
}

function readArrayElements(source: string): Array<string> | null {
	const text = source.trim()
	if (!text.startsWith('[')) return null
	const elements: Array<string> = []
	let index = 1
	while (index < text.length) {
		index = skipWhitespaceAndComments(text, index)
		if (text[index] === ']') return elements
		if (text[index] === ',') {
			index += 1
			continue
		}
		if (text.startsWith('...', index)) return null
		const value = readExpression(text, index)
		if (value == null) return null
		elements.push(value.text)
		index = value.end
	}
	return null
}

function isLiteral(expression: string): boolean {
	const text = expression.trim()
	if (/^(?:null|undefined|true|false|-?\d+(?:\.\d+)?)$/.test(text)) return true
	if (isPlainTemplate(text)) return true
	return (
		staticStringValue(text) != null &&
		(text.startsWith("'") || text.startsWith('"'))
	)
}

function staticStringValue(expression: string): string | null {
	const text = expression.trim()
	if (isPlainTemplate(text)) return text.slice(1, -1)
	if (
		(text.startsWith("'") && text.endsWith("'")) ||
		(text.startsWith('"') && text.endsWith('"'))
	) {
		if (text.length < 2) return null
		const body = text.slice(1, -1)
		if (body.includes(text[0]!) || body.includes('\n')) return null
		return body.replace(/\\(.)/g, '$1')
	}
	return null
}

function isPlainTemplate(expression: string): boolean {
	const text = expression.trim()
	return (
		text.startsWith('`') &&
		text.endsWith('`') &&
		!text.slice(1, -1).includes('${')
	)
}

function matchCallee(
	expression: string,
	callee: string,
): { args: Array<string> } | null {
	const text = expression.trim()
	if (!text.startsWith(callee)) return null
	const open = skipWhitespaceAndComments(text, callee.length)
	if (text[open] !== '(') return null
	const call = readCallArguments(text, open)
	if (call == null) return null
	const end = skipWhitespaceAndComments(text, endOfCall(text, open))
	if (end !== text.length) return null
	return call
}

function matchNewCallee(
	expression: string,
	name: string,
): { args: Array<string> } | null {
	const text = expression.trim()
	if (!text.startsWith('new')) return null
	const nameAt = skipWhitespaceAndComments(text, 'new'.length)
	if (!text.startsWith(name, nameAt)) return null
	return matchCallee(text.slice(nameAt), name)
}

function endOfCall(source: string, openParen: number): number {
	const args = readCallArguments(source, openParen)
	if (args == null) return openParen
	let index = openParen
	let paren = 0
	while (index < source.length) {
		const char = source[index]!
		if (char === "'" || char === '"') {
			index = skipQuotedString(source, index)
			continue
		}
		if (char === '`') {
			index = skipTemplate(source, index, [])
			continue
		}
		if (char === '(') paren += 1
		else if (char === ')') {
			paren -= 1
			if (paren === 0) return index + 1
		}
		index += 1
	}
	return source.length
}

function skipTemplate(
	source: string,
	start: number,
	calls: Array<FetchLikeCall>,
): number {
	let index = start + 1
	while (index < source.length) {
		const char = source[index]!
		if (char === '\\') {
			index += 2
			continue
		}
		if (char === '`') return index + 1
		if (char === '$' && source[index + 1] === '{') {
			index = scanCode(source, index + 2, 'brace', calls)
			continue
		}
		index += 1
	}
	return index
}

function skipQuotedString(source: string, start: number): number {
	const quote = source[start]!
	let index = start + 1
	while (index < source.length) {
		const char = source[index]!
		if (char === '\\') {
			index += 2
			continue
		}
		if (char === quote) return index + 1
		if (char === '\n') return index
		index += 1
	}
	return index
}

function skipLineComment(source: string, start: number): number {
	const newline = source.indexOf('\n', start)
	return newline === -1 ? source.length : newline + 1
}

function skipBlockComment(source: string, start: number): number {
	const end = source.indexOf('*/', start + 2)
	return end === -1 ? source.length : end + 2
}

function skipWhitespaceAndComments(source: string, start: number): number {
	let index = start
	while (index < source.length) {
		const char = source[index]!
		if (isWhitespace(char)) {
			index += 1
			continue
		}
		if (char === '/' && source[index + 1] === '/') {
			index = skipLineComment(source, index)
			continue
		}
		if (char === '/' && source[index + 1] === '*') {
			index = skipBlockComment(source, index)
			continue
		}
		break
	}
	return index
}

function lineAt(source: string, index: number): number {
	let line = 1
	for (let cursor = 0; cursor < index && cursor < source.length; cursor += 1) {
		if (source[cursor] === '\n') line += 1
	}
	return line
}

function isWhitespace(char: string): boolean {
	return char === ' ' || char === '\t' || char === '\n' || char === '\r'
}

function isIdentStart(char: string): boolean {
	return /[A-Za-z_$]/.test(char)
}

function isIdentPart(char: string): boolean {
	return /[A-Za-z0-9_$]/.test(char)
}
