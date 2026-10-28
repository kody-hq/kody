/**
 * Migration error for callers that still send the removed server-side
 * execute `invoke` field (MCP `execute`, Open API `/v1/execute`).
 *
 * Follow-up: drop this module and its call sites no earlier than 2026-11-27
 * (30 days after the removal); after that an `invoke` key is just an unknown
 * argument.
 */

const removedFieldName = 'invoke'

function canonicalSpecifier(raw: unknown): string | null {
	if (typeof raw !== 'string') return null
	let value = raw.trim()
	if (!value || /\s/.test(value)) return null
	const hashIndex = value.indexOf('#')
	if (hashIndex >= 0) {
		const before = value.slice(0, hashIndex)
		const after = value.slice(hashIndex + 1).replace(/^\.\//, '')
		if (!before || after.includes('#')) return null
		value = after && after !== '.' ? `${before}/${after}` : before
	}
	if (value.startsWith('@')) value = `kody:${value}`
	if (!/^kody:@[^/]+\/[^/]/.test(value)) return null
	return value
}

/**
 * The `code` equivalent of an `invoke` call: the same thin passthrough the
 * shortcut used to generate.
 */
export function executeInvokeEquivalentCode(invoke: unknown): string {
	const specifier = canonicalSpecifier(invoke) ?? 'kody:@scope/package/export'
	return `import action from ${JSON.stringify(specifier)}\nexport default (params) => action(params)`
}

export function executeInvokeRemovedMessage(invoke: unknown): string {
	const code = executeInvokeEquivalentCode(invoke)
	return [
		'execute no longer accepts `invoke`. Send the same call as `code` (keep `params` as they are):',
		code,
		'As one JSON string: "code": ' + JSON.stringify(code),
		'The Kody CLI `kody execute --invoke` flag still works: current CLI versions write this module for you and send it as code (upgrade @kodycodes/cli if yours sends invoke).',
	].join('\n')
}

/** True when the caller sent the removed `invoke` field at all. */
export function hasRemovedExecuteInvoke(args: unknown): args is {
	[removedFieldName]: unknown
} {
	return (
		typeof args === 'object' &&
		args !== null &&
		!Array.isArray(args) &&
		removedFieldName in args &&
		(args as Record<string, unknown>)[removedFieldName] !== undefined
	)
}
