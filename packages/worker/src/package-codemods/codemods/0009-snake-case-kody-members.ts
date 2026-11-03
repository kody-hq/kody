import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import { snakeToCamelIdentifier } from '#mcp/capabilities/runtime-identifier.ts'
import type {
	PackageCodemod,
	PackageCodemodFinding,
	PackageCodemodTransformResult,
} from '../types.ts'

export const snakeCaseKodyMembersCodemodId = '0009-snake-case-kody-members'

const rewriteMessage =
	'Uses a snake_case `kody` member or capability entity ref; rewrite to camelCase.'
const manualComputedMessage =
	'Uses computed `kody[id]` where `id` is data; recase the runtime value to camelCase manually.'
const parseFailureMessage =
	'File references a snake_case `kody` member but could not be parsed; recase to camelCase manually.'

const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/
const markdownFilePattern = /\.mdx?$/
const snakeCaseIdentifierPattern = /^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)+$/
const entityRefPattern =
	/\bcapability:([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)\b/g
const markdownMemberPattern =
	/\bkody\.([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)\b/g
const markdownComputedPattern =
	/\bkody\[["']([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)["']\]/g

type AstNode = ModuleAstNode & {
	start?: number
	end?: number
	computed?: boolean
	name?: unknown
	value?: unknown
	object?: AstNode
	property?: AstNode
	source?: AstNode
	specifiers?: Array<AstNode>
	local?: AstNode
	imported?: AstNode
	program?: { body?: Array<AstNode> }
	body?: Array<AstNode>
}

function getNodeName(node: AstNode | null | undefined) {
	if (!node) return null
	if (typeof node.name === 'string') return node.name
	if (typeof node.value === 'string') return node.value
	return null
}

function parseProgram(source: string): AstNode | null {
	try {
		return parseModuleSource(source) as unknown as AstNode
	} catch {
		return null
	}
}

function getProgramBody(parsed: AstNode): Array<AstNode> {
	const program = parsed.program
	const body = program?.body ?? parsed.body
	return Array.isArray(body) ? body : []
}

function walkAst(
	node: AstNode,
	parent: AstNode | null,
	visit: (node: AstNode, parent: AstNode | null) => void,
) {
	visit(node, parent)
	for (const [key, value] of Object.entries(node)) {
		if (
			key === 'loc' ||
			key === 'start' ||
			key === 'end' ||
			key === 'range' ||
			key === 'leadingComments' ||
			key === 'trailingComments' ||
			key === 'innerComments' ||
			key === 'comments'
		) {
			continue
		}
		if (Array.isArray(value)) {
			for (const child of value) {
				if (child && typeof child === 'object' && 'type' in child) {
					walkAst(child as AstNode, node, visit)
				}
			}
			continue
		}
		if (value && typeof value === 'object' && 'type' in value) {
			walkAst(value as AstNode, node, visit)
		}
	}
}

function sourceHasGlobalPattern(pattern: RegExp, source: string) {
	pattern.lastIndex = 0
	return pattern.test(source)
}

function sourceHasSnakeCaseKodyMember(source: string) {
	return /kody\.[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+/.test(source)
}

function sourceHasEntityRef(source: string) {
	return sourceHasGlobalPattern(entityRefPattern, source)
}

function collectKodyAliases(body: Array<AstNode>) {
	// Leftover ambient `kody.foo_bar` calls (the style the deleted typecheck
	// stubs allowed) still need recasing even when the file never imported
	// `kody` from `kody:runtime`.
	const aliases = new Set<string>(['kody'])
	for (const node of body) {
		if (node.type !== 'ImportDeclaration') continue
		if (getNodeName(node.source) !== 'kody:runtime') continue
		for (const specifier of node.specifiers ?? []) {
			if (specifier.type !== 'ImportSpecifier') continue
			if (getNodeName(specifier.imported) !== 'kody') continue
			const local = getNodeName(specifier.local)
			if (local) aliases.add(local)
		}
	}
	return aliases
}

function isKodyRoot(node: AstNode, aliases: Set<string>) {
	return node.type === 'Identifier' && aliases.has(getNodeName(node) ?? '')
}

function isMcpNamespaceAccess(node: AstNode, aliases: Set<string>): boolean {
	let current: AstNode | undefined = node
	while (current) {
		if (
			(current.type === 'MemberExpression' ||
				current.type === 'OptionalMemberExpression') &&
			current.computed !== true &&
			getNodeName(current.property) === 'mcp' &&
			current.object &&
			isKodyRoot(current.object, aliases)
		) {
			return true
		}
		current = current.object
	}
	return false
}

type RewriteSite = {
	start: number
	end: number
	replacement: string
}

function collectModuleRewriteSites(
	source: string,
	aliases: Set<string>,
): {
	sites: Array<RewriteSite>
	needsManual: boolean
	hasSnakeMember: boolean
} {
	const parsed = parseProgram(source)
	if (!parsed) {
		return {
			sites: [],
			needsManual: sourceHasSnakeCaseKodyMember(source),
			hasSnakeMember: false,
		}
	}
	const sites: Array<RewriteSite> = []
	let needsManual = false
	let hasSnakeMember = false
	walkAst(parsed, null, (node) => {
		if (node.type === 'StringLiteral' || node.type === 'Literal') {
			const value = getNodeName(node)
			if (
				value &&
				typeof node.start === 'number' &&
				typeof node.end === 'number' &&
				sourceHasEntityRef(value)
			) {
				entityRefPattern.lastIndex = 0
				const recased = value.replace(
					entityRefPattern,
					(_match, name: string) =>
						`capability:${snakeToCamelIdentifier(name)}`,
				)
				if (recased !== value) {
					sites.push({
						start: node.start,
						end: node.end,
						replacement: JSON.stringify(recased),
					})
				}
			}
			return
		}
		if (
			node.type !== 'MemberExpression' &&
			node.type !== 'OptionalMemberExpression'
		) {
			return
		}
		if (!node.object || isMcpNamespaceAccess(node.object, aliases)) return
		if (!isKodyRoot(node.object, aliases)) return
		if (node.computed === true) {
			const literalName = getNodeName(node.property)
			if (
				literalName &&
				snakeCaseIdentifierPattern.test(literalName) &&
				typeof node.property?.start === 'number' &&
				typeof node.property.end === 'number' &&
				node.object.end != null
			) {
				hasSnakeMember = true
				sites.push({
					start: node.object.end,
					end: node.end ?? node.property.end,
					replacement: `.${snakeToCamelIdentifier(literalName)}`,
				})
				return
			}
			needsManual = true
			return
		}
		const property = node.property
		const propertyName = getNodeName(property)
		if (
			propertyName &&
			snakeCaseIdentifierPattern.test(propertyName) &&
			property &&
			typeof property.start === 'number' &&
			typeof property.end === 'number'
		) {
			hasSnakeMember = true
			sites.push({
				start: property.start,
				end: property.end,
				replacement: snakeToCamelIdentifier(propertyName),
			})
		}
	})
	return { sites, needsManual, hasSnakeMember }
}

function applyRewriteSites(source: string, sites: Array<RewriteSite>) {
	const ordered = [...sites].sort((left, right) => right.start - left.start)
	let next = source
	for (const site of ordered) {
		next = `${next.slice(0, site.start)}${site.replacement}${next.slice(site.end)}`
	}
	return next
}

function rewriteMarkdown(source: string) {
	return source
		.replace(
			markdownComputedPattern,
			(_match, name: string) => `kody.${snakeToCamelIdentifier(name)}`,
		)
		.replace(
			markdownMemberPattern,
			(_match, name: string) => `kody.${snakeToCamelIdentifier(name)}`,
		)
		.replace(
			entityRefPattern,
			(_match, name: string) => `capability:${snakeToCamelIdentifier(name)}`,
		)
}

function hasMarkdownSnakeCase(source: string) {
	return (
		sourceHasGlobalPattern(markdownMemberPattern, source) ||
		sourceHasGlobalPattern(markdownComputedPattern, source) ||
		sourceHasEntityRef(source)
	)
}

function detectSnakeCaseKodyMembers(
	files: Record<string, string>,
): Array<PackageCodemodFinding> {
	const findings: Array<PackageCodemodFinding> = []
	for (const [path, source] of Object.entries(files)) {
		if (typeof source !== 'string') continue
		if (markdownFilePattern.test(path) && hasMarkdownSnakeCase(source)) {
			findings.push({ path, message: rewriteMessage })
			continue
		}
		if (!scannableModuleFilePattern.test(path)) continue
		const parsed = parseProgram(source)
		if (!parsed) {
			if (sourceHasSnakeCaseKodyMember(source) || sourceHasEntityRef(source)) {
				findings.push({ path, message: parseFailureMessage })
			}
			continue
		}
		const aliases = collectKodyAliases(getProgramBody(parsed))
		if (
			aliases.size === 0 &&
			!sourceHasEntityRef(source) &&
			!sourceHasSnakeCaseKodyMember(source)
		) {
			continue
		}
		const { needsManual, hasSnakeMember } = collectModuleRewriteSites(
			source,
			aliases,
		)
		const hasEntityRef = sourceHasEntityRef(source)
		if (hasSnakeMember || hasEntityRef) {
			findings.push({ path, message: rewriteMessage })
		} else if (needsManual) {
			findings.push({ path, message: manualComputedMessage })
		}
	}
	return findings.sort((left, right) =>
		(left.path ?? '').localeCompare(right.path ?? ''),
	)
}

function transformSnakeCaseKodyMembers(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	const nextFiles: Record<string, string> = { ...files }
	const changedPaths: Array<string> = []
	const needsManual: Array<PackageCodemodFinding> = []
	for (const [path, source] of Object.entries(files)) {
		if (typeof source !== 'string') continue
		if (markdownFilePattern.test(path)) {
			const rewritten = rewriteMarkdown(source)
			if (rewritten !== source) {
				nextFiles[path] = rewritten
				changedPaths.push(path)
			}
			continue
		}
		if (!scannableModuleFilePattern.test(path)) continue
		const parsed = parseProgram(source)
		if (!parsed) {
			if (sourceHasSnakeCaseKodyMember(source) || sourceHasEntityRef(source)) {
				needsManual.push({ path, message: parseFailureMessage })
			}
			continue
		}
		const aliases = collectKodyAliases(getProgramBody(parsed))
		const { sites, needsManual: computedNeedsManual } =
			collectModuleRewriteSites(source, aliases)
		const rewritten = applyRewriteSites(source, sites)
		if (rewritten !== source) {
			nextFiles[path] = rewritten
			changedPaths.push(path)
		}
		if (computedNeedsManual) {
			needsManual.push({ path, message: manualComputedMessage })
		}
	}
	changedPaths.sort((left, right) => left.localeCompare(right))
	needsManual.sort((left, right) =>
		(left.path ?? '').localeCompare(right.path ?? ''),
	)
	return {
		files: nextFiles,
		changed: changedPaths.length > 0,
		changedPaths,
		needsManual,
	}
}

export const snakeCaseKodyMembersCodemod: PackageCodemod = {
	id: snakeCaseKodyMembersCodemodId,
	description:
		'Rewrite snake_case `kody.foo_bar` / `kody["foo_bar"]` calls and `capability:foo_bar` entity refs to camelCase. Leaves MCP tools on `kody.mcp` unchanged.',
	detect: detectSnakeCaseKodyMembers,
	transform: transformSnakeCaseKodyMembers,
}
