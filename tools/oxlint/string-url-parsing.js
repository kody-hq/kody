const stringMethods = new Set([
	'includes',
	'indexOf',
	'lastIndexOf',
	'startsWith',
	'endsWith',
	'split',
])

const urlLikeName =
	/(?:^|[a-z_])(?:url|href|uri|origin|redirect|redirectto|returnto|referer|referrer|callback|callbackurl)$/i

// Root-relative checks (`href.startsWith('/')`, `'//'`), trailing-slash
// normalization before `new URL(path, base)`, and backslash rejection read no
// URL structure, so they stay string checks.
const allowedLiteralCalls = new Set([
	'startsWith:/',
	'startsWith://',
	'endsWith:/',
	'includes:\\',
])

const testFilePattern = /\.(?:test|spec)\.[^.]+$/

function receiverName(node) {
	if (node.type === 'Identifier') return node.name
	if (node.type === 'MemberExpression' && !node.computed) {
		return node.property.type === 'Identifier' ? node.property.name : null
	}
	if (node.type === 'ChainExpression') return receiverName(node.expression)
	return null
}

/** Name of a URL-like value whose string methods would parse it by hand. */
function stringUrlParsingReceiver(callee) {
	if (callee.type !== 'MemberExpression' || callee.computed) return null
	if (callee.property.type !== 'Identifier') return null
	if (!stringMethods.has(callee.property.name)) return null
	const name = receiverName(callee.object)
	return name && urlLikeName.test(name) ? name : null
}

function isAllowedLiteralCall(node) {
	const [argument] = node.arguments
	if (node.arguments.length !== 1 || argument.type !== 'Literal') return false
	return allowedLiteralCalls.has(
		`${node.callee.property.name}:${String(argument.value)}`,
	)
}

export const noStringUrlParsingRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'URL-like strings are parsed with URL / URLSearchParams, not string methods.',
		},
		schema: [],
		messages: {
			stringUrlParsing:
				'Parse `{{name}}` with `new URL(...)` (or `new URL(value, base)` for relative links) and read `.protocol`, `.hostname`, `.origin`, `.pathname`, or `.searchParams`; build queries with `URLSearchParams`. Compare hosts exactly or with a `.${suffix}` check on the parsed hostname.',
		},
	},
	createOnce(context) {
		return {
			CallExpression(node) {
				if (testFilePattern.test(context.filename)) return
				const name = stringUrlParsingReceiver(node.callee)
				if (!name || isAllowedLiteralCall(node)) return
				context.report({
					node,
					messageId: 'stringUrlParsing',
					data: { name },
				})
			},
		}
	},
}
