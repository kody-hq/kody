const javascriptReservedWords = new Set([
	'await',
	'break',
	'case',
	'catch',
	'class',
	'const',
	'continue',
	'debugger',
	'default',
	'delete',
	'do',
	'else',
	'enum',
	'export',
	'extends',
	'false',
	'finally',
	'for',
	'function',
	'if',
	'import',
	'in',
	'instanceof',
	'new',
	'null',
	'return',
	'super',
	'switch',
	'this',
	'throw',
	'true',
	'try',
	'typeof',
	'var',
	'void',
	'while',
	'with',
	'yield',
	'let',
	'static',
	'implements',
	'interface',
	'package',
	'private',
	'protected',
	'public',
])

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const snakeCasePattern = /_/

export function snakeToCamelIdentifier(name: string) {
	return name.replace(/_([a-zA-Z0-9])/g, (_, char: string) =>
		char.toUpperCase(),
	)
}

export function assertKodyRuntimeIdentifier(
	kind: 'capability' | 'domain',
	name: string,
) {
	if (!identifierPattern.test(name) || javascriptReservedWords.has(name)) {
		throw new Error(
			`${kind === 'capability' ? 'Capability' : 'Domain'} name "${name}" must be a JavaScript identifier so it can be called as kody.${name}(...).`,
		)
	}
	if (snakeCasePattern.test(name)) {
		throw new Error(
			`${kind === 'capability' ? 'Capability' : 'Domain'} name "${name}" must be camelCase, not snake_case. Use "${snakeToCamelIdentifier(name)}".`,
		)
	}
}
