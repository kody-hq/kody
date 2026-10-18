/**
 * Credential storage is read only behind `resolveCredential`. This test
 * parses every non-test source file under `packages/` and fails when a
 * credential read or decrypt helper is imported (or re-exported, or reached
 * through a namespace import) outside the door and its resolvers, its storage
 * layer, or the explicit account-management list below.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../..',
)
const workerRoot = path.join(repoRoot, 'packages/worker')
const doorModules = new Set([
	'packages/worker/src/credentials/resolve-credential.ts',
	'packages/worker/src/credentials/secret-resolvers.ts',
	'packages/worker/src/credentials/oauth-resolvers.ts',
	'packages/worker/src/credentials/mcp-resolver.ts',
	'packages/worker/src/credentials/url-resolver.ts',
	'packages/worker/src/credentials/login-resolver.ts',
	'packages/worker/src/credentials/signing-resolver.ts',
	'packages/worker/src/credentials/client-resolver.ts',
])

type StorageRule = {
	/** Repo-relative module that owns the storage read. */
	module: string
	/** Exports that return credential material. */
	symbols: ReadonlyArray<string>
	/** Importers allowed besides the door and its resolvers, with why. */
	allowed: Record<string, string>
}

const accountSecretsHandler =
	'packages/worker/src/app/handlers/account-secrets.ts'
const accountSecretsData = 'packages/worker/src/app/account-secrets-data.ts'

const storageRules: ReadonlyArray<StorageRule> = [
	{
		module: 'packages/worker/src/mcp/secrets/service.ts',
		symbols: [
			'resolveSecret',
			'findSecretForUse',
			'findStoredCredentialForUse',
		],
		allowed: {
			'packages/worker/src/credentials/stored-credential.ts':
				'Later-kind lookup; only door resolvers call its readValue, after authorizing.',
			'packages/worker/src/mcp/secrets/secret-providers/service.ts':
				'Vault door key read inside resolveProviderSecret, which only the door calls.',
			[accountSecretsHandler]:
				'Account management: keeps the stored value when an edit leaves it blank.',
			[accountSecretsData]:
				'Account management: the owner reveals a stored secret on /account/secrets.',
		},
	},
	{
		module: 'packages/worker/src/mcp/secrets/repo.ts',
		symbols: ['getSecretEntry', 'getStoredCredentialEntry'],
		allowed: {
			'packages/worker/src/mcp/secrets/service.ts': 'Secret storage layer.',
		},
	},
	{
		module: 'packages/worker/src/mcp/secrets/crypto.ts',
		symbols: [
			'decryptSecretValue',
			'decryptUserOauthAccessToken',
			'decryptUserOauthRefreshToken',
			'decryptUserOauthClientSecret',
		],
		allowed: {
			'packages/worker/src/mcp/secrets/service.ts': 'Secret storage layer.',
			'packages/worker/src/integrations/credentials.ts':
				'Integration token storage layer.',
			'packages/worker/src/oauth-refresh-family.ts':
				"Kody's own OAuth refresh-family state, not an org credential.",
			'packages/worker/src/org-transfer/reencrypt.ts':
				'Admin org resource transfer re-seals ciphertext from the source to the target owner context; plaintext never leaves the function.',
			'packages/worker/src/orgs/convert-personal-org.ts':
				'Personal-org conversion re-seals user secrets, OAuth apps, and integrations into the new personal org context; plaintext never leaves the function.',
		},
	},
	{
		module: 'packages/worker/src/integrations/credentials.ts',
		symbols: [
			'resolveIntegrationAccessToken',
			'resolveIntegrationRefreshToken',
			'resolveUserOauthAppClientSecret',
		],
		allowed: {
			'packages/worker/src/integrations/token-refresh.ts':
				'Refresh primitive, reached only through the door.',
			[accountSecretsHandler]:
				'Account management: OAuth connect exchanges the code with the stored client secret.',
			'packages/worker/src/integrations/connect-oauth-persist.ts':
				'Shared connect persist: resolves a stored BYO client secret when the browser omits it on device or code exchange.',
		},
	},
	{
		module: 'packages/worker/src/integrations/token-refresh.ts',
		symbols: ['refreshIntegrationTokens'],
		allowed: {},
	},
	{
		module: 'packages/worker/src/mcp/secrets/secret-providers/service.ts',
		symbols: ['resolveProviderSecret'],
		allowed: {},
	},
	{
		module: 'packages/worker/src/mcp/secrets/secret-providers/cache.ts',
		symbols: ['readProviderSecretCache'],
		allowed: {
			'packages/worker/src/mcp/secrets/secret-providers/service.ts':
				'Vault storage layer.',
		},
	},
	{
		module: 'packages/worker/src/mcp-client/hub-client.ts',
		symbols: ['callMcpServerTool'],
		allowed: {},
	},
	// A resolver handle's `apply` reads credential material, so only the door
	// may hold a resolver: anywhere else would skip the door's checks and audit.
	{
		module: 'packages/worker/src/credentials/secret-resolvers.ts',
		symbols: [
			'secretResolver',
			'webhookSecretResolver',
			'packageSecretMountResolver',
			'vaultSecretResolver',
		],
		allowed: {},
	},
	{
		module: 'packages/worker/src/credentials/oauth-resolvers.ts',
		symbols: ['integrationTokenResolver', 'integrationRefreshResolver'],
		allowed: {},
	},
	{
		module: 'packages/worker/src/credentials/mcp-resolver.ts',
		symbols: ['mcpConnectionResolver'],
		allowed: {},
	},
	{
		module: 'packages/worker/src/credentials/stored-credential.ts',
		symbols: ['findStoredCredential'],
		allowed: {},
	},
	{
		module: 'packages/worker/src/credentials/url-resolver.ts',
		symbols: ['urlCredentialResolver'],
		allowed: {},
	},
	{
		module: 'packages/worker/src/credentials/login-resolver.ts',
		symbols: ['loginCredentialResolver'],
		allowed: {},
	},
	{
		module: 'packages/worker/src/credentials/signing-resolver.ts',
		symbols: ['signingCredentialResolver'],
		allowed: {},
	},
	{
		module: 'packages/worker/src/credentials/client-resolver.ts',
		symbols: [
			'clientKeyResolver',
			'clientOauthResolver',
			'clientOauthRefreshResolver',
		],
		allowed: {},
	},
]

const skippedDirectories = new Set([
	'node_modules',
	'dist',
	'build',
	'.wrangler',
])

function isTestOnly(relativePath: string) {
	return (
		/\.(node|workers|mcp-e2e|browser)?\.?test\.tsx?$/.test(relativePath) ||
		relativePath.includes('/test-support/') ||
		relativePath.includes('/e2e/')
	)
}

function listSourceFiles(directory: string): Array<string> {
	const files: Array<string> = []
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (skippedDirectories.has(entry.name)) continue
		const fullPath = path.join(directory, entry.name)
		if (entry.isDirectory()) {
			files.push(...listSourceFiles(fullPath))
		} else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
			files.push(fullPath)
		}
	}
	return files
}

const workerImportAliases: ReadonlyArray<[string, string]> = [
	['#app/', 'src/app/'],
	['#client/', 'client/'],
	['#universal/', 'universal/'],
	['#worker/', 'src/'],
	['#mcp/', 'src/mcp/'],
]

function resolveSpecifier(importer: string, specifier: string): string | null {
	let resolved: string | null = null
	if (specifier.startsWith('.')) {
		resolved = path.resolve(path.dirname(importer), specifier)
	} else if (importer.startsWith(workerRoot + path.sep)) {
		const alias = workerImportAliases.find(([prefix]) =>
			specifier.startsWith(prefix),
		)
		if (alias) {
			resolved = path.join(
				workerRoot,
				alias[1],
				specifier.slice(alias[0].length),
			)
		}
	}
	return resolved
		? path.relative(repoRoot, resolved).split(path.sep).join('/')
		: null
}

type ImportUse = { module: string; names: Array<string> | '*' }

function collectImports(filePath: string, source: string): Array<ImportUse> {
	const sourceFile = ts.createSourceFile(
		filePath,
		source,
		ts.ScriptTarget.Latest,
		false,
		filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	)
	const uses: Array<ImportUse> = []
	const add = (
		specifier: ts.Expression | undefined,
		names: ImportUse['names'],
	) => {
		if (!specifier || !ts.isStringLiteral(specifier)) return
		const module = resolveSpecifier(filePath, specifier.text)
		if (module) uses.push({ module, names })
	}
	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node)) {
			const bindings = node.importClause?.namedBindings
			if (bindings && ts.isNamespaceImport(bindings)) {
				add(node.moduleSpecifier, '*')
			} else if (bindings && ts.isNamedImports(bindings)) {
				add(
					node.moduleSpecifier,
					bindings.elements.map(
						(element) => (element.propertyName ?? element.name).text,
					),
				)
			}
		} else if (ts.isExportDeclaration(node)) {
			const clause = node.exportClause
			add(
				node.moduleSpecifier,
				clause && ts.isNamedExports(clause)
					? clause.elements.map(
							(element) => (element.propertyName ?? element.name).text,
						)
					: '*',
			)
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword
		) {
			add(node.arguments[0], '*')
		}
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	return uses
}

test('credential storage is read only behind resolveCredential', () => {
	const rulesByModule = new Map(storageRules.map((rule) => [rule.module, rule]))
	const violations: Array<string> = []
	for (const filePath of listSourceFiles(path.join(repoRoot, 'packages'))) {
		const importer = path.relative(repoRoot, filePath).split(path.sep).join('/')
		if (isTestOnly(importer)) continue
		for (const use of collectImports(
			filePath,
			readFileSync(filePath, 'utf8'),
		)) {
			const rule = rulesByModule.get(use.module)
			if (!rule || doorModules.has(importer) || importer in rule.allowed)
				continue
			const reached =
				use.names === '*'
					? ['* (namespace import or re-export)']
					: use.names.filter((name) => rule.symbols.includes(name))
			for (const name of reached) {
				violations.push(`${importer} imports ${name} from ${rule.module}`)
			}
		}
	}
	expect(
		violations,
		'Resolve credentials through resolveCredential (packages/worker/src/credentials/resolve-credential.ts).',
	).toEqual([])
})
