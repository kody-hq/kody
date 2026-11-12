export type JsonNode = {
	id: string
	name: string
	kind: string
	count: number
	preview: string
}
type JsonToken = {
	text: string
	kind: 'key' | 'string' | 'number' | 'literal' | 'plain'
}
export type JsonLine = {
	number: number
	continuation: boolean
	tokens: JsonToken[]
}
export type JsonRequest =
	| { type: 'load'; src: string; content?: string }
	| { type: 'children'; id: string; offset: number }
export type JsonResponse =
	| { type: 'ready'; lines: JsonLine[]; root?: JsonNode; invalid?: string }
	| {
			type: 'children'
			id: string
			offset: number
			children: JsonNode[]
			total: number
	  }
	| { type: 'error'; message: string }

/** Tokenize JSON without interpreting markup. Long lines become visual continuations. */
export function jsonSourceLines(source: string): JsonLine[] {
	const lines: JsonLine[] = []
	let line: JsonLine = { number: 1, continuation: false, tokens: [] },
		length = 0
	const append = (text: string, kind: JsonToken['kind']) => {
		for (const part of text.split(/(\r?\n)/)) {
			if (/^\r?\n$/.test(part)) {
				lines.push(line)
				line = { number: line.number + 1, continuation: false, tokens: [] }
				length = 0
				continue
			}
			let offset = 0
			while (offset < part.length) {
				if (length === 2000) {
					lines.push(line)
					line = { number: line.number, continuation: true, tokens: [] }
					length = 0
				}
				const text = part.slice(offset, offset + 2000 - length)
				line.tokens.push({ text, kind })
				offset += text.length
				length += text.length
			}
		}
	}
	const pattern =
		/"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g
	let end = 0
	const keySuffix = /\s*:/y
	for (const token of source.matchAll(pattern)) {
		const index = token.index!
		append(source.slice(end, index), 'plain')
		const text = token[0]
		keySuffix.lastIndex = index + text.length
		const kind = text.startsWith('"')
			? keySuffix.test(source)
				? 'key'
				: 'string'
			: /^-?\d/.test(text)
				? 'number'
				: 'literal'
		append(text, kind)
		end = index + text.length
	}
	append(source.slice(end), 'plain')
	lines.push(line)
	return lines
}
export function describeJson(
	id: string,
	name: string,
	value: unknown,
): JsonNode {
	const array = Array.isArray(value),
		object = value !== null && typeof value === 'object'
	const kind = array
		? 'array'
		: object
			? 'object'
			: value === null
				? 'null'
				: typeof value
	return {
		id,
		name: Array.from(
			name.length > 300 ? name.slice(0, 300) + '…' : name,
			(character) =>
				character.charCodeAt(0) < 32
					? JSON.stringify(character).slice(1, -1)
					: character,
		).join(''),
		kind,
		count: array ? value.length : object ? Object.keys(value).length : 0,
		preview: object
			? ''
			: typeof value === 'string'
				? JSON.stringify(value.length > 300 ? value.slice(0, 300) + '…' : value)
				: String(value),
	}
}
