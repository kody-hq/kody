import {
	personalOrgId,
	personIdFromStored,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { applyD1Migrations, type D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { persistIntegrationTokens } from '#worker/integrations/credentials.ts'
import {
	lockIntegrationToPackage,
	upsertIntegration,
} from '#worker/integrations/service.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import {
	buildKodyImportableModuleBundle,
	buildKodyModuleBundle,
} from '#worker/package-runtime/module-graph.ts'
import { persistPublishedBundleArtifact } from '#worker/package-runtime/published-bundle-artifacts.ts'
import { persistPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

/**
 * An integration locked to one package must work when hosted execute
 * imports that package: the package's `createAuthenticatedFetch` and
 * `oauthClientCredentials` act as the package, the same as local execute,
 * jobs, and webhooks. Direct execute and other packages stay refused.
 * Dummy token and a stubbed upstream only.
 */

const testEnv = env as Env & {
	TEST_MIGRATIONS: Array<D1Migration>
	TEST_AUDIT_MIGRATIONS: Array<D1Migration>
}

beforeAll(async () => {
	await applyD1Migrations(testEnv.APP_DB, testEnv.TEST_MIGRATIONS)
	await applyD1Migrations(testEnv.AUDIT_DB, testEnv.TEST_AUDIT_MIGRATIONS)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

const DUMMY_TOKEN = 'dummy-locked-integration-token'
const INTEGRATION = 'lockedsvc'

type Person = {
	username: string
	stableUserId: string
	personId: PersonId
	ownerId: OwnerId
}

function installFakeUpstream() {
	const seen: Array<{ path: string; authorization: string | null }> = []
	const realFetch = globalThis.fetch
	vi.stubGlobal(
		'fetch',
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input as RequestInfo, init)
			const url = new URL(request.url)
			if (url.hostname !== 'upstream.example.com') {
				return realFetch(input as RequestInfo, init)
			}
			seen.push({
				path: url.pathname,
				authorization: request.headers.get('authorization'),
			})
			return Response.json({ ok: true })
		},
	)
	return seen
}

async function createPerson(): Promise<Person> {
	const username = `lk${crypto.randomUUID().slice(0, 8)}`
	const stableUserId = `u-${crypto.randomUUID()}`
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id, personal_org_id)
		 VALUES (?, ?, 'x', ?, ?)`,
	)
		.bind(username, `${username}@example.com`, stableUserId, stableUserId)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId,
		username,
		createdAt: new Date().toISOString(),
	})
	const personId = personIdFromStored(stableUserId)
	return { username, stableUserId, personId, ownerId: personalOrgId(personId) }
}

function caller(person: Person) {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.dev',
		user: {
			userId: person.personId,
			username: person.username,
			email: `${person.username}@example.com`,
			displayName: person.username,
			personalOrgId: person.ownerId,
		},
	})
}

const callSource = `import { createAuthenticatedFetch } from 'kody:runtime'
export default async function call() {
	const authed = await createAuthenticatedFetch(${JSON.stringify(INTEGRATION)})
	const res = await authed('https://upstream.example.com/locked')
	return { status: res.status }
}`

/**
 * A bundle as the builder stored it before createAuthenticatedFetch was
 * package-bound: the inlined facade imports it from the shared runtime.
 */
function legacyFacadeBundle(packageId: string) {
	const id = JSON.stringify(packageId)
	return `// virtual:.__kody_virtual__/package-runtime/0000.js
import { createAuthenticatedFetch, secretHeaders, oauthClientCredentials, packageContext, email, workflows, packages, events } from "./.__kody_virtual__/runtime.js";
import __kodyBaseRuntimeDefault, { __kodyCreatePackageBoundStorage, __kodyCreatePackageBoundSecrets, __kodyCreatePackageBoundCredentialRuntime, __kodyCreatePackageBoundFetch, __kodyCreatePackageBoundKody } from "./.__kody_virtual__/runtime.js";
var __kodyBoundFetch = __kodyCreatePackageBoundFetch(${id});
var kody = __kodyCreatePackageBoundKody(${id});
var packageStorage = __kodyCreatePackageBoundStorage(${id});
var packageSecrets = __kodyCreatePackageBoundSecrets(${id});
var __kodyPackageCredentialRuntime = __kodyCreatePackageBoundCredentialRuntime(${id});
var credential = __kodyPackageCredentialRuntime.credential;
var credentials = __kodyPackageCredentialRuntime.credentials;
var __kodyPackageBound = Object.fromEntries(
  Object.entries({ packageStorage, packageSecrets, credential, credentials }).filter(
    ([, value]) => value !== void 0
  )
);
var __kodyPackageRuntimeDefault = new Proxy(__kodyBaseRuntimeDefault, {
  get(target, property, receiver) {
    if (Object.hasOwn(__kodyPackageBound, property)) return __kodyPackageBound[property];
    return Reflect.get(target, property, receiver);
  },
  has(target, property) {
    return Object.hasOwn(__kodyPackageBound, property) || Reflect.has(target, property);
  }
});
var KodyRuntime = Object.freeze({ defaultValue: __kodyPackageRuntimeDefault });

// virtual:.__kody_root__/src/call.ts
async function call() {
  const authed = await createAuthenticatedFetch(${JSON.stringify(INTEGRATION)});
  const res = await authed("https://upstream.example.com/locked");
  return { status: res.status };
}

// virtual:.__kody_root__/.__kody_import_entry__.js
var kody_import_entry_default = call;
export {
  kody_import_entry_default as default
};
`
}

async function publishPackage(
	person: Person,
	leaf: string,
	files: Record<string, string> = { 'src/call.ts': callSource },
	options: { legacyBundle?: boolean } = {},
) {
	const unique = crypto.randomUUID()
	const packageId = `pkg-${unique}`
	const sourceId = `source-${unique}`
	const publishedCommit = `commit-${unique}`
	const name = `@${person.username}/${leaf}`
	const now = new Date().toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 0, ?, ?)`,
	)
		.bind(
			packageId,
			person.ownerId,
			name,
			leaf,
			`${leaf} package`,
			sourceId,
			now,
			now,
		)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit,
			indexed_commit, manifest_path, source_root, created_at, updated_at
		) VALUES (?, ?, 'package', ?, ?, ?, NULL, 'package.json', '/', ?, ?)`,
	)
		.bind(
			sourceId,
			person.ownerId,
			packageId,
			`repo-${sourceId}`,
			publishedCommit,
			now,
			now,
		)
		.run()
	const source = {
		id: sourceId,
		user_id: person.ownerId,
		entity_kind: 'package' as const,
		entity_id: packageId,
		repo_id: `repo-${sourceId}`,
		published_commit: publishedCommit,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: now,
		updated_at: now,
	}
	const sourceFiles = {
		'package.json': JSON.stringify({
			name,
			exports: { './call': './src/call.ts' },
			kody: { id: leaf, description: `${leaf} package` },
		}),
		...files,
	}
	await persistPublishedSourceSnapshot({
		env,
		userId: person.ownerId,
		source,
		snapshot: { files: sourceFiles },
	})
	const bundle = await buildKodyImportableModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId: person.ownerId,
		sourceFiles,
		entryPoint: 'src/call.ts',
		rootPackageId: packageId,
	})
	await persistPublishedBundleArtifact({
		env,
		userId: person.ownerId,
		source,
		kind: 'importable-module',
		artifactName: './call',
		entryPoint: 'src/call.ts',
		...(options.legacyBundle
			? {
					mainModule: 'bundle.js',
					modules: { 'bundle.js': legacyFacadeBundle(packageId) },
					dependencies: [],
				}
			: {
					mainModule: bundle.mainModule,
					modules: bundle.modules,
					dependencies: bundle.dependencies,
				}),
		packageContext: { packageId, kodyId: leaf, sourceId },
	})
	return { packageId, name }
}

async function connectLockedIntegration(person: Person, packageId: string) {
	await upsertIntegration({
		env,
		userId: person.ownerId,
		config: {
			name: INTEGRATION,
			tokenUrl: 'https://upstream.example.com/oauth/token',
			apiBaseUrl: 'https://upstream.example.com',
			flow: 'confidential',
			clientId: 'dummy-client-id',
			requiredHosts: ['upstream.example.com'],
			authorization: {
				authorizeUrl: 'https://upstream.example.com/oauth/authorize',
				scopes: ['read'],
				scopeSeparator: null,
				extraAuthorizeParams: {},
			},
		},
		audit: null,
	})
	await persistIntegrationTokens({
		env,
		userId: person.ownerId,
		name: INTEGRATION,
		accessToken: DUMMY_TOKEN,
		refreshPolicy: 'required',
		audit: null,
	})
	await lockIntegrationToPackage({
		env,
		userId: person.ownerId,
		name: INTEGRATION,
		packageId,
		audit: null,
	})
}

async function execute(person: Person, code: string) {
	const bundle = await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId: person.ownerId,
		sourceFiles: { 'entry.ts': code },
		entryPoint: 'entry.ts',
	})
	return await runBundledModuleWithRegistry(env, caller(person), bundle)
}

function importAndCall(packageName: string) {
	return `import call from 'kody:${packageName}/call'
export default async function main() {
	return await call()
}`
}

test(
	'hosted execute importing the allowed package uses the locked integration',
	{ timeout: 120_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const person = await createPerson()
		const allowed = await publishPackage(person, 'allowed')
		await connectLockedIntegration(person, allowed.packageId)
		const seen = installFakeUpstream()

		const run = await execute(person, importAndCall(allowed.name))

		expect(run.error).toBeUndefined()
		expect(run.result).toEqual({ status: 200 })
		expect(seen).toEqual([
			{ path: '/locked', authorization: `Bearer ${DUMMY_TOKEN}` },
		])
	},
)

test(
	'direct execute is still refused for a locked integration',
	{ timeout: 120_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const person = await createPerson()
		const allowed = await publishPackage(person, 'allowed')
		await connectLockedIntegration(person, allowed.packageId)
		const seen = installFakeUpstream()

		const run = await execute(
			person,
			callSource.replace(
				'export default async function call',
				'export default async function main',
			),
		)

		expect(String(run.error)).toContain('limited to specific packages')
		expect(
			seen.filter((entry) => entry.authorization?.includes(DUMMY_TOKEN)),
		).toEqual([])
	},
)

test(
	'hosted execute importing another package is refused for a locked integration',
	{ timeout: 120_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const person = await createPerson()
		const allowed = await publishPackage(person, 'allowed')
		const other = await publishPackage(person, 'other')
		await connectLockedIntegration(person, allowed.packageId)
		const seen = installFakeUpstream()

		const run = await execute(person, importAndCall(other.name))

		expect(String(run.error)).toContain('is not approved to use integration')
		expect(
			seen.filter((entry) => entry.authorization?.includes(DUMMY_TOKEN)),
		).toEqual([])
	},
)

test(
	'execute passthrough of the allowed package export uses the locked integration',
	{ timeout: 120_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const person = await createPerson()
		const allowed = await publishPackage(person, 'allowed')
		await connectLockedIntegration(person, allowed.packageId)
		const seen = installFakeUpstream()

		const run = await execute(
			person,
			`import call from ${JSON.stringify(`kody:${allowed.name}/call`)}\nexport default (params) => call(params)`,
		)

		expect(run.error).toBeUndefined()
		expect(run.result).toEqual({ status: 200 })
		expect(seen).toEqual([
			{ path: '/locked', authorization: `Bearer ${DUMMY_TOKEN}` },
		])
	},
)

test(
	'a bundle stored before the fix is bound to its package when it loads',
	{ timeout: 120_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const person = await createPerson()
		const allowed = await publishPackage(person, 'allowed', undefined, {
			legacyBundle: true,
		})
		await connectLockedIntegration(person, allowed.packageId)
		const seen = installFakeUpstream()

		const run = await execute(person, importAndCall(allowed.name))

		expect(run.error).toBeUndefined()
		expect(run.result).toEqual({ status: 200 })
		expect(seen).toEqual([
			{ path: '/locked', authorization: `Bearer ${DUMMY_TOKEN}` },
		])
	},
)
