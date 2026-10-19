import {
	findOversizedOfficialGuideSections,
	isOfficialGuideCatalogFile,
} from './guide-section-budget.js'
import {
	findTautologicalAbsenceMatches,
	isTestPath,
	loadTautologicalAbsenceCorpus,
	locForRange,
	otherContentsFromCorpus,
	repoRelativePath,
} from './tautological-absence.js'

const EXAMPLE_IDENTIFIER = '__oxlint_plugin_example__'
const CLIENT_ROUTE_FILE_PATTERN =
	/(^|\/)packages\/worker\/client\/routes\/.+\.(ts|tsx)$/
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[^.]+$/
const SHARED_LOADER_DATA_TYPE_NAMES = new Set([
	'AccountSecretListItem',
	'AccountSecretDetail',
	'AccountSecretsLoaderData',
	'AccountPackagesLoaderData',
	'AccountIntegrationsLoaderData',
	'AccountIntegrationListItem',
])

const noExampleIdentifierRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Demonstrates how to author a custom oxlint JS plugin rule in this repo.',
		},
		schema: [],
		messages: {
			avoidExampleIdentifier:
				'Avoid using __oxlint_plugin_example__. This identifier exists only to verify the custom oxlint rule example.',
		},
	},
	createOnce(context) {
		return {
			Identifier(node) {
				if (node.name !== EXAMPLE_IDENTIFIER) return
				context.report({ node, messageId: 'avoidExampleIdentifier' })
			},
		}
	},
}

function isLiteralFrameSrc(value) {
	if (!value) return false
	if (value.type === 'Literal' && typeof value.value === 'string') return true
	if (value.type !== 'JSXExpressionContainer') return false
	const expression = value.expression
	if (expression.type === 'Literal' && typeof expression.value === 'string') {
		return true
	}
	return expression.type === 'TemplateLiteral'
}

function normalizeFilePath(filename) {
	return typeof filename === 'string' ? filename.replaceAll('\\', '/') : ''
}

function isClientRouteFile(filename) {
	return CLIENT_ROUTE_FILE_PATTERN.test(normalizeFilePath(filename))
}

function isTestFile(filename) {
	return TEST_FILE_PATTERN.test(normalizeFilePath(filename))
}

function shouldImportSharedLoaderDataType(typeName) {
	if (!typeName) return false
	return (
		typeName.endsWith('LoaderData') ||
		SHARED_LOADER_DATA_TYPE_NAMES.has(typeName)
	)
}

function getDeclaredTypeName(node) {
	if (!node?.id || node.id.type !== 'Identifier') return null
	return node.id.name
}

const noLiteralFrameSrcRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Require typed route href() expressions for Remix Frame src props.',
		},
		schema: [],
		messages: {
			useRoutesHref:
				'<Frame src> must use routes.<name>.href(...) instead of a string or template literal.',
		},
	},
	createOnce(context) {
		return {
			JSXOpeningElement(node) {
				if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'Frame') {
					return
				}

				for (const attribute of node.attributes) {
					if (attribute.type !== 'JSXAttribute') continue
					if (
						attribute.name.type !== 'JSXIdentifier' ||
						attribute.name.name !== 'src'
					) {
						continue
					}
					if (!isLiteralFrameSrc(attribute.value)) continue
					context.report({ node: attribute, messageId: 'useRoutesHref' })
				}
			},
		}
	},
}

const preferLoaderDataTypesRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Require client routes to import shared loader-data payload types instead of redeclaring them locally.',
		},
		schema: [],
		messages: {
			importFromLoaderData:
				'Import shared payload types from #universal/loader-data.ts instead of redeclaring this type in a client route.',
		},
	},
	createOnce(context) {
		let shouldCheckCurrentFile = false

		function reportIfNeeded(node) {
			if (!shouldCheckCurrentFile) return
			const typeName = getDeclaredTypeName(node)
			if (!shouldImportSharedLoaderDataType(typeName)) return
			context.report({ node, messageId: 'importFromLoaderData' })
		}

		return {
			Program() {
				shouldCheckCurrentFile = isClientRouteFile(context.filename)
			},
			TSTypeAliasDeclaration(node) {
				reportIfNeeded(node)
			},
			TSInterfaceDeclaration(node) {
				reportIfNeeded(node)
			},
		}
	},
}

/**
 * Enforced import direction between worker layers. `#app/*` is the HTTP/UI
 * layer, `#mcp/*` is the capability layer beneath it, `#universal/*` is the
 * client-safe contract layer both the browser bundle and the worker may
 * import, and the rest of `#worker/*` holds server primitives. Imports may
 * only point downward, so shared code has to be extracted into a neutral
 * `#worker/*` or `#universal/*` module instead of growing a cycle.
 *
 * Each boundary lists the `allowedSpecifiers` that still cross it. Add to a
 * list only with a `reason` explaining why the edge cannot be extracted yet —
 * a new violation should fail lint, not quietly join the list.
 */
export const importBoundaries = [
	{
		id: 'mcp-to-app',
		filePattern: /(^|\/)packages\/worker\/src\/mcp\/.+$/,
		forbiddenPrefixes: ['#app/'],
		message:
			'#mcp/* must not import from #app/*. Extract the shared code into a neutral #worker/* or #universal/* module (see docs/contributing/import-boundaries.md).',
		allowedSpecifiers: [],
		/**
		 * Never allowlisted: request handlers are the top of the app layer, so
		 * a capability that needs handler logic is always the wrong shape.
		 */
		neverAllowedPrefix: '#app/handlers/',
		neverAllowedMessage:
			'#mcp/* must never import an #app/handlers/* request handler. Move the shared logic into a neutral #worker/* or #universal/* module.',
	},
	{
		id: 'package-registry-to-mcp',
		filePattern: /(^|\/)packages\/worker\/src\/package-registry\/.+$/,
		forbiddenPrefixes: ['#mcp/'],
		message:
			'#worker/package-registry/* must not import from #mcp/*. Extract the shared code into a neutral #worker/* or #universal/* module (see docs/contributing/import-boundaries.md).',
		allowedSpecifiers: [],
		neverAllowedPrefix: null,
		neverAllowedMessage: null,
	},
	{
		id: 'client-to-server',
		filePattern: /(^|\/)packages\/worker\/(client|universal)\/.+$/,
		forbiddenPrefixes: ['#app/', '#worker/', '#mcp/'],
		message:
			'Client and universal modules must not import #app/*, #worker/*, or #mcp/*. Put the shared contract in #universal/* (see docs/contributing/import-boundaries.md).',
		allowedSpecifiers: [],
		neverAllowedPrefix: null,
		neverAllowedMessage: null,
		skipTestFiles: true,
	},
	{
		id: 'universal-to-client',
		filePattern: /(^|\/)packages\/worker\/universal\/.+$/,
		forbiddenPrefixes: ['#client/'],
		message:
			'#universal/* must not import #client/*. Shared UI tokens and components belong in #universal/* so SSR and the client bundle can both use them.',
		allowedSpecifiers: [],
		neverAllowedPrefix: null,
		neverAllowedMessage: null,
	},
]

function getForbiddenPrefixes(boundary) {
	if (Array.isArray(boundary.forbiddenPrefixes)) {
		return boundary.forbiddenPrefixes
	}
	return boundary.forbiddenPrefix ? [boundary.forbiddenPrefix] : []
}

function findBoundaryViolation(boundary, specifier) {
	if (
		boundary.neverAllowedPrefix &&
		specifier.startsWith(boundary.neverAllowedPrefix)
	) {
		return boundary.neverAllowedMessage
	}
	const matchesForbidden = getForbiddenPrefixes(boundary).some((prefix) =>
		specifier.startsWith(prefix),
	)
	if (!matchesForbidden) return null
	const allowed = boundary.allowedSpecifiers.some(
		(entry) => entry.specifier === specifier,
	)
	return allowed ? null : boundary.message
}

/**
 * Boundaries that apply to `filename`. Exported so the rule and its test agree
 * on which files each boundary covers.
 */
export function getImportBoundariesForFile(filename) {
	const normalized = normalizeFilePath(filename)
	return importBoundaries.filter((boundary) => {
		if (boundary.skipTestFiles && isTestFile(normalized)) return false
		return boundary.filePattern.test(normalized)
	})
}

/**
 * The message a boundary would report for `specifier`, or null when the import
 * is allowed. Exported for `import-boundaries.node.test.ts`.
 */
export function findImportBoundaryViolation(filename, specifier) {
	for (const boundary of getImportBoundariesForFile(filename)) {
		const detail = findBoundaryViolation(boundary, specifier)
		if (detail) return detail
	}
	return null
}

let tautologicalAbsenceCorpus = null

function tautologicalAbsenceCorpusFor() {
	if (!tautologicalAbsenceCorpus) {
		tautologicalAbsenceCorpus = loadTautologicalAbsenceCorpus()
	}
	return tautologicalAbsenceCorpus
}

let officialGuideSectionOverflows = null

function officialGuideSectionOverflowsFor() {
	if (!officialGuideSectionOverflows) {
		officialGuideSectionOverflows = findOversizedOfficialGuideSections()
	}
	return officialGuideSectionOverflows
}

const noOversizedGuideSectionRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Reject official guide sections that exceed the search body budget (maxChars minus the entity header) so guide:{id}#{slug} can return the full heading.',
		},
		schema: [],
		messages: {
			oversizedSection:
				'Official guide section "{{file}}#{{slug}}" is {{chars}} characters (limit {{limit}} after the search entity header). Split the heading or move detail so search({ entity: "guide:{id}#{slug}" }) can return the full section.',
		},
	},
	createOnce(context) {
		return {
			Program(node) {
				// createOnce cannot read context.filename at setup. Official
				// guides are markdown, so this visitor reports on the catalog
				// TypeScript haystack after walking docs/guides/.
				if (!isOfficialGuideCatalogFile(context.filename)) return
				for (const overflow of officialGuideSectionOverflowsFor()) {
					context.report({
						node,
						messageId: 'oversizedSection',
						data: {
							file: overflow.file,
							slug: overflow.slug,
							chars: String(overflow.chars),
							limit: String(overflow.limit),
						},
					})
				}
			},
		}
	},
}

const noTautologicalAbsenceRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Reject instructional-copy not.toContain leftovers when the string exists only as that absence assertion.',
		},
		schema: [],
		messages: {
			vanishedCopy:
				'Do not keep a lone not.toContain of copy that no longer exists in the repo ({{needle}}). Fine while deleting; drop the assertion before commit. Keep absence checks that flip state or still appear on another path.',
		},
	},
	createOnce(context) {
		return {
			Program() {
				const relativePath = repoRelativePath(context.filename)
				if (!isTestPath(relativePath)) return
				const source = context.sourceCode.getText()
				const matches = findTautologicalAbsenceMatches({
					relativePath,
					content: source,
					otherContents: otherContentsFromCorpus(
						tautologicalAbsenceCorpusFor(),
						relativePath,
					),
				})
				for (const match of matches) {
					context.report({
						loc: locForRange(source, match.start, match.end),
						messageId: 'vanishedCopy',
						data: { needle: JSON.stringify(match.needle) },
					})
				}
			},
		}
	},
}

const enforceImportBoundariesRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Enforce worker layer import direction so mcp/app, package-registry/mcp, and client/server cycles cannot grow.',
		},
		schema: [],
		messages: {
			crossesBoundary: '{{detail}}',
		},
	},
	createOnce(context) {
		let activeBoundaries = []

		function check(node, specifier) {
			if (typeof specifier !== 'string') return
			for (const boundary of activeBoundaries) {
				const detail = findBoundaryViolation(boundary, specifier)
				if (!detail) continue
				context.report({
					node,
					messageId: 'crossesBoundary',
					data: { detail },
				})
				return
			}
		}

		return {
			Program() {
				activeBoundaries = getImportBoundariesForFile(context.filename)
			},
			ImportDeclaration(node) {
				check(node, node.source.value)
			},
			ExportNamedDeclaration(node) {
				if (!node.source) return
				check(node, node.source.value)
			},
			ExportAllDeclaration(node) {
				check(node, node.source.value)
			},
			ImportExpression(node) {
				if (node.source.type !== 'Literal') return
				check(node, node.source.value)
			},
			// `vi.mock('#app/...')` reaches across the same boundary, so tests
			// cannot route around the rule.
			CallExpression(node) {
				const [first] = node.arguments
				if (first?.type !== 'Literal') return
				if (
					node.callee.type === 'MemberExpression' &&
					node.callee.object.type === 'Identifier' &&
					node.callee.object.name === 'vi' &&
					node.callee.property.type === 'Identifier' &&
					(node.callee.property.name === 'mock' ||
						node.callee.property.name === 'unmock')
				) {
					check(node, first.value)
				}
			},
		}
	},
}

const plugin = {
	meta: { name: 'kody-custom' },
	rules: {
		'enforce-import-boundaries': enforceImportBoundariesRule,
		'no-example-identifier': noExampleIdentifierRule,
		'no-literal-frame-src': noLiteralFrameSrcRule,
		'no-oversized-guide-section': noOversizedGuideSectionRule,
		'no-tautological-absence': noTautologicalAbsenceRule,
		'prefer-loader-data-types': preferLoaderDataTypesRule,
	},
}

export default plugin
