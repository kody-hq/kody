/**
 * What an execute run can do with credentials, worked out before it starts
 * so routing can skip a context whose grant could not serve it (ADR 0083).
 * Covers the entry module and every package its static `kody:` imports reach.
 */
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	listUsableCredentials,
	listUsableCredentialsByPackage,
	liveUsableCredentials,
} from '#worker/credentials/credential-candidates.ts'
import { type CredentialCallMap } from '#worker/credentials/credential-call-map.ts'
import { packageSourceFiles } from '#worker/credentials/credential-needs-closure.ts'
import { readStoredCredentialNeeds } from '#worker/credentials/credential-needs.ts'
import {
	isStoredCredentialStamp,
	omitOversizedCredentialStampModules,
	scanCredentialStamp,
} from '#worker/credentials/credential-stamp.ts'
import {
	type AstNode,
	findPlaceholderMatches,
	getNodeName,
	listScannableModulePaths,
	parseModule,
	walkAst,
} from '#worker/credentials/module-placeholder-scan.ts'
import { collectModuleKodyCalls } from '#worker/package-codemods/codemods/0017-detect-package-app-visitor-authority.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { resolveSavedPackageImport } from '#worker/package-runtime/package-import-resolution.ts'
import {
	readPublishedCredentialNeeds,
	readPublishedCredentialStamp,
	readPublishedCredentialUse,
	readPublishedSourceSnapshot,
	writePublishedCredentialUse,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { collectStaticKodyPackageImportsFromFiles } from '#worker/package-runtime/static-kody-imports.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { isCredentialedRuntimeCall } from './credential-grant.ts'

/**
 * `none`: the run uses no credential. `ids`: every credential it can use is
 * one of these. `unknown`: it can use credentials, but which ones is not
 * statically known.
 */
export type RunCredentialUse =
	| { kind: 'none' }
	| { kind: 'ids'; ids: Array<string> }
	| { kind: 'unknown' }

const unknownUse: RunCredentialUse = { kind: 'unknown' }

const credentialRuntimeExports = new Set([
	'credential',
	'credentials',
	'createAuthenticatedFetch',
])
const runtimeNamedImportPattern =
	/import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"]kody:runtime['"]/g
const runtimeWholeImportPattern =
	/import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\}\s*)?from\s*['"]kody:runtime['"]/g

/** A credential helper imported from `kody:runtime` and used. */
function codeImportsCredentialHelpers(code: string) {
	for (const match of code.matchAll(runtimeNamedImportPattern)) {
		const names = match[1]!.split(',').map((part) =>
			part
				.trim()
				.replace(/^type\s+/, '')
				.split(/\s+as\s+/)[0]!
				.trim(),
		)
		if (names.some((name) => credentialRuntimeExports.has(name))) return true
	}
	for (const match of code.matchAll(runtimeWholeImportPattern)) {
		const alias = match[1]!.replace(/[$]/g, '\\$')
		if (
			new RegExp(
				`\\b${alias}\\s*\\.\\s*(?:credentials?|createAuthenticatedFetch)\\b`,
			).test(code)
		) {
			return true
		}
	}
	return false
}

/**
 * True when execute code visibly needs a credential: a secret or
 * integration placeholder, or a credential helper from `kody:runtime`. The
 * cheap source check that runs before any parse or package lookup.
 */
export function codeNeedsCredentials(code: string | null) {
	if (!code) return false
	return (
		findPlaceholderMatches(code).length > 0 ||
		codeImportsCredentialHelpers(code)
	)
}

function runtimeCallUsesCredentials(name: string) {
	return (
		isCredentialedRuntimeCall(name) ||
		credentialRuntimeExports.has(name) ||
		name.startsWith('packageSecret')
	)
}

/**
 * One parsed module calls a credentialed `kody.*` runtime API, imports a
 * credential helper from `kody:runtime`, or calls `kody` with a name picked
 * at run time (which could be either).
 */
export function moduleUsesCredentials(parsed: AstNode) {
	const calls = collectModuleKodyCalls(parsed)
	if (calls.computedCalls > 0) return true
	if ([...calls.names].some(runtimeCallUsesCredentials)) return true
	const runtimeNames = new Set<string>()
	for (const node of parsed.program?.body ?? []) {
		if (node.type !== 'ImportDeclaration') continue
		if (getNodeName(node.source) !== 'kody:runtime') continue
		for (const specifier of node.specifiers ?? []) {
			if (
				specifier.type === 'ImportNamespaceSpecifier' ||
				specifier.type === 'ImportDefaultSpecifier'
			) {
				const local = getNodeName(specifier.local)
				if (local) runtimeNames.add(local)
				continue
			}
			if (specifier.type !== 'ImportSpecifier') continue
			const imported = getNodeName(specifier.imported)
			if (imported && credentialRuntimeExports.has(imported)) return true
		}
	}
	return runtimeNames.size > 0 && readsCredentialedMember(parsed, runtimeNames)
}

/**
 * Credentialed reads through a namespace or default `kody:runtime` import:
 * `rt.kody.authenticatedFetch`, `rt.kody[name]`, `const { gatewayFetch } =
 * rt.kody`, and the same through a local alias of `rt` or `rt.kody`.
 */
function readsCredentialedMember(parsed: AstNode, runtimeNames: Set<string>) {
	const names = new Set(runtimeNames)
	const fromRuntime = (node: AstNode | undefined) => {
		const root = rootIdentifier(node)
		return root != null && names.has(root)
	}
	let found = false
	walkAst(parsed, (node) => {
		if (found) return
		if (
			node.type === 'MemberExpression' ||
			node.type === 'OptionalMemberExpression'
		) {
			if (!fromRuntime(node.object)) return
			const name = memberName(node)
			if (name == null || runtimeCallUsesCredentials(name)) found = true
			return
		}
		if (node.type !== 'VariableDeclarator' || !fromRuntime(node.init)) return
		if (node.id?.type === 'Identifier') {
			const alias = getNodeName(node.id)
			if (alias) names.add(alias)
			return
		}
		if (node.id?.type !== 'ObjectPattern') return
		for (const property of node.id.properties ?? []) {
			const key =
				property.type === 'RestElement' || property.computed
					? null
					: getNodeName(property.key)
			if (key == null || runtimeCallUsesCredentials(key)) found = true
		}
	})
	return found
}

function rootIdentifier(node: AstNode | undefined): string | null {
	let current = node
	while (
		current?.type === 'MemberExpression' ||
		current?.type === 'OptionalMemberExpression'
	) {
		current = current.object
	}
	return current?.type === 'Identifier' ? getNodeName(current) : null
}

/** The property a member expression reads; null when picked at run time. */
function memberName(node: AstNode) {
	if (!node.computed) return getNodeName(node.property)
	const property = node.property
	if (property?.type === 'StringLiteral' || property?.type === 'Literal') {
		return typeof property.value === 'string' ? property.value : null
	}
	return null
}

function recordHasEntries(value: unknown) {
	return (
		value != null &&
		typeof value === 'object' &&
		Object.keys(value as object).length > 0
	)
}

/**
 * A package's own files can use a credential: declared credentials or secret
 * mounts, a credential the stamp scanner finds (placeholders, `credential()`
 * keys, signing secrets, or use it cannot stamp), or a credentialed runtime
 * call. `files` are relative to the package's source root.
 */
export function packageFilesUseCredentials(files: Record<string, string>) {
	const manifestSource = files['package.json']
	if (typeof manifestSource === 'string') {
		try {
			const kody = (JSON.parse(manifestSource) as { kody?: unknown }).kody as
				| { credentials?: unknown; secretMounts?: unknown }
				| undefined
			if (
				recordHasEntries(kody?.credentials) ||
				recordHasEntries(kody?.secretMounts)
			) {
				return true
			}
		} catch {
			return true
		}
	}
	const scannable = omitOversizedCredentialStampModules(files)
	const stamp = scanCredentialStamp(scannable)
	if (stamp.keys.length > 0 || stamp.failures.length > 0) return true
	for (const path of listScannableModulePaths(scannable)) {
		const parsed = parseModule(scannable[path]!)
		if (!parsed || moduleUsesCredentials(parsed)) return true
	}
	return false
}

type DependencyRef =
	| { packageId: string; publishedCommit: string }
	| { packageName: string }

type StoredNode = { version: 1; uses: boolean; deps: Array<DependencyRef> }

function isStoredNode(value: unknown): value is StoredNode {
	const node = value as StoredNode | null
	return (
		node != null &&
		typeof node === 'object' &&
		node.version === 1 &&
		typeof node.uses === 'boolean' &&
		Array.isArray(node.deps)
	)
}

const nodeMemoLimit = 500
const nodeMemo = new Map<string, StoredNode>()

function rememberNode(key: string, node: StoredNode) {
	if (nodeMemo.size >= nodeMemoLimit) {
		const oldest = nodeMemo.keys().next().value
		if (oldest !== undefined) nodeMemo.delete(oldest)
	}
	nodeMemo.set(key, node)
}

/** Clears the per-isolate cache. Tests only. */
export function resetRunCredentialUseCacheForTest() {
	nodeMemo.clear()
}

/**
 * One published package's own credential use and the packages it imports.
 * Stored publish metadata answers first; otherwise its published files are
 * parsed once and the answer is kept per source and commit.
 */
async function loadPublishedNode(
	env: Env,
	source: EntitySourceRow,
	publishedCommit: string,
): Promise<StoredNode> {
	const key = `${source.id}:${publishedCommit}`
	const memo = nodeMemo.get(key)
	if (memo) return memo
	const ref = { env, sourceId: source.id, publishedCommit }
	const cached = await readPublishedCredentialUse(ref)
	if (isStoredNode(cached)) {
		rememberNode(key, cached)
		return cached
	}
	const { node, durable } = await computePublishedNode(ref, source)
	if (!durable) return node
	rememberNode(key, node)
	try {
		await writePublishedCredentialUse({ ...ref, use: node })
	} catch {
		// Only a cache: a failed write must not change the routing answer.
	}
	return node
}

async function computePublishedNode(
	ref: { env: Env; sourceId: string; publishedCommit: string },
	source: EntitySourceRow,
): Promise<{ node: StoredNode; durable: boolean }> {
	const uses: { node: StoredNode; durable: boolean } = {
		node: { version: 1, uses: true, deps: [] },
		durable: true,
	}
	const [needs, stamp, snapshot] = await Promise.all([
		readPublishedCredentialNeeds(ref),
		readPublishedCredentialStamp(ref),
		readPublishedSourceSnapshot(ref),
	])
	if ((readStoredCredentialNeeds(needs)?.length ?? 0) > 0) return uses
	const stored = isStoredCredentialStamp(stamp) ? stamp : null
	if (stored && stored.keys.length > 0) return uses
	// A missing snapshot may only be mid-publish, so do not cache that answer.
	if (!snapshot) return { ...uses, durable: false }
	const { files } = packageSourceFiles({ source, files: snapshot.files })
	if (packageFilesUseCredentials(files)) return uses
	const deps: Array<DependencyRef> = stored
		? stored.depStamps.map((dep) => ({
				packageId: dep.packageId,
				publishedCommit: dep.publishedCommit,
			}))
		: [
				...new Set(
					collectStaticKodyPackageImportsFromFiles(files).map(
						(imported) => imported.packageName,
					),
				),
			].map((packageName) => ({ packageName }))
	return { node: { version: 1, uses: false, deps }, durable: true }
}

const maxGraphPackages = 64

/**
 * True when any package the entry's static `kody:` imports reach, directly
 * or through other packages, can use a credential. Packages resolve the way
 * the runtime resolves them (the caller's org; dependencies at the commit
 * the importing package was published against). Anything that cannot be
 * resolved or read counts as using credentials.
 */
export async function importGraphUsesCredentials(input: {
	env: Env
	request: RequestContext
	ownerId: string
	code: string
}): Promise<boolean> {
	let pending: Array<DependencyRef>
	try {
		pending = [
			...new Set(
				collectStaticKodyPackageImportsFromFiles({
					'entry.ts': input.code,
				}).map((imported) => imported.packageName),
			),
		].map((packageName) => ({ packageName }))
	} catch {
		return true
	}
	if (pending.length === 0) return false
	const db = input.env.APP_DB
	const visited = new Set<string>()
	const packageIds = new Set<string>()
	while (pending.length > 0) {
		const ref = pending.pop()!
		let row: { id: string; sourceId: string } | null
		try {
			row =
				'packageName' in ref
					? ((
							await resolveSavedPackageImport({
								db,
								userId: input.ownerId,
								specifier: { packageName: ref.packageName, exportName: '.' },
							})
						)?.row ?? null)
					: await getSavedPackageById(db, {
							userId: input.ownerId,
							packageId: ref.packageId,
						})
		} catch {
			return true
		}
		if (!row) return true
		const source = await getEntitySourceById(db, row.sourceId)
		const publishedCommit =
			'publishedCommit' in ref
				? ref.publishedCommit
				: (source?.published_commit ?? null)
		if (!source || !publishedCommit) return true
		const key = `${source.id}:${publishedCommit}`
		if (visited.has(key)) continue
		if (visited.size >= maxGraphPackages) return true
		visited.add(key)
		packageIds.add(row.id)
		const node = await loadPublishedNode(input.env, source, publishedCommit)
		if (node.uses) return true
		pending.push(...node.deps)
	}
	// A Key bound to one of these packages is a credential its code can use.
	const byPackage = await listUsableCredentialsByPackage({
		env: input.env,
		request: input.request,
		packageIds: [...packageIds],
	})
	for (const [packageId, credentials] of byPackage) {
		if (credentials.some((credential) => credential.packageId === packageId)) {
			return true
		}
	}
	return false
}

type CredentialRef = { name: string; scope: 'org' | 'personal' | null }

/**
 * Credentials the entry module names, or null when it can use one it does
 * not name (a credential helper, a credentialed runtime call, or a
 * placeholder whose target is not a plain credential name).
 */
export function entryCredentialRefs(
	code: string,
	credentials: CredentialCallMap | null,
): Array<CredentialRef> | null {
	const refs: Array<CredentialRef> = []
	for (const picks of credentials?.values() ?? []) {
		for (const pick of picks) refs.push({ name: pick.name, scope: pick.scope })
	}
	for (const match of findPlaceholderMatches(code)) {
		if (match.kind !== 'secret' && match.kind !== 'secret-basic') return null
		if (match.scope !== null) return null
		for (const name of match.names) refs.push({ name, scope: null })
	}
	if (codeImportsCredentialHelpers(code)) return null
	const parsed = parseModule(code)
	if (parsed && moduleUsesCredentials(parsed)) return null
	return refs
}

/**
 * What the run can do with credentials. A failure to work it out counts as
 * `unknown`, so a context that allows no credentials is skipped rather than
 * failing mid-run.
 */
export async function resolveRunCredentialUse(input: {
	env: Env
	request: RequestContext
	ownerId: string
	code: string | null
	credentials: CredentialCallMap | null
}): Promise<RunCredentialUse> {
	if (!input.code) {
		return input.credentials && input.credentials.size > 0
			? unknownUse
			: { kind: 'none' }
	}
	try {
		const refs = entryCredentialRefs(input.code, input.credentials)
		if (!refs) return unknownUse
		if (
			await importGraphUsesCredentials({
				env: input.env,
				request: input.request,
				ownerId: input.ownerId,
				code: input.code,
			})
		) {
			return unknownUse
		}
		if (refs.length === 0) return { kind: 'none' }
		const usable = liveUsableCredentials(
			await listUsableCredentials({ env: input.env, request: input.request }),
		)
		const ids = new Set<string>()
		for (const ref of refs) {
			const candidates = usable.filter(
				(credential) =>
					credential.name === ref.name &&
					(ref.scope === null || credential.scope === ref.scope),
			)
			if (candidates.length === 0) return unknownUse
			for (const candidate of candidates) ids.add(candidate.id)
		}
		return { kind: 'ids', ids: [...ids].sort() }
	} catch (error) {
		console.warn('execution-context-credential-use-failed', error)
		return unknownUse
	}
}
