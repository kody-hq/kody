import {
	personIdFromStored,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { ensurePersonalOrg } from '#worker/orgs/provision.ts'
import { buildKodyModuleBundle } from './module-graph.ts'

export async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

export async function insertSavedPackage(input: {
	userId: string
	packageId: string
	kodyId: string
	name: string
	sourceId: string
	publishedCommit: string
}) {
	const now = new Date().toISOString()
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 0, ?, ?)`,
		input.packageId,
		input.userId,
		input.name,
		input.kodyId,
		`${input.name} package`,
		input.sourceId,
		now,
		now,
	)
	await runSql(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit,
			indexed_commit, manifest_path, source_root, created_at, updated_at
		) VALUES (?, ?, 'package', ?, ?, ?, NULL, 'package.json', '/', ?, ?)`,
		input.sourceId,
		input.userId,
		input.packageId,
		`repo-${input.sourceId}`,
		input.publishedCommit,
		now,
		now,
	)
	return {
		id: input.sourceId,
		user_id: ownerIdFromStored(input.userId),
		entity_kind: 'package' as const,
		entity_id: input.packageId,
		repo_id: `repo-${input.sourceId}`,
		published_commit: input.publishedCommit,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: now,
		updated_at: now,
	}
}

export type PublishedPackage = {
	packageId: string
	sourceId: string
	kodyId: string
}

export const wakeMount = (scope: 'user' | 'package' = 'user') => ({
	wakeToken: { name: 'wakeToken', scope },
})

export function manifest(
	name: string,
	kody: Record<string, unknown>,
	extra = {},
) {
	return JSON.stringify({ name, ...extra, kody })
}

export async function provisionTestUser(userId: string, username: string) {
	await ensurePersonalOrg(env.APP_DB, { stableUserId: userId, username })
}

export function createCallerContext(userId: string) {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.dev',
		user: {
			userId: personIdFromStored(userId),
			username: 'worker-test',
			email: 'worker@example.com',
			displayName: 'Worker Test',
		},
	})
}

export async function buildModule(
	userId: string,
	sourceFiles: Record<string, string>,
	entryPoint = 'entry.ts',
	rootPackageId?: string,
) {
	return await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId,
		sourceFiles,
		entryPoint,
		...(rootPackageId ? { rootPackageId } : {}),
	})
}

export async function runModule(
	userId: string,
	sourceFiles: Record<string, string>,
	options: { entryPoint?: string; asPackage?: PublishedPackage } = {},
) {
	const { asPackage } = options
	return await runBundledModuleWithRegistry(
		env,
		createCallerContext(userId),
		await buildModule(
			userId,
			sourceFiles,
			options.entryPoint,
			asPackage?.packageId,
		),
		undefined,
		{
			skipCapabilityRegistry: true,
			...(asPackage
				? {
						packageContext: {
							packageId: asPackage.packageId,
							kodyId: asPackage.kodyId,
							sourceId: asPackage.sourceId,
						},
					}
				: {}),
		},
	)
}

export const DUMMY_SECRET = 'dummy-A-only-secret-0000'

export const NEW_TOKEN = 'dummy-newly-issued-access-token-1111'

export type Seen = {
	method: string
	url: string
	authorization: string | null
	body: string
}

export const B_SECRET = 'dummy-B-only-secret-2222'

export function installFakeUpstream() {
	const seen: Array<Seen> = []
	const realFetch = globalThis.fetch
	vi.stubGlobal(
		'fetch',
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input as RequestInfo, init)
			const url = new URL(request.url)
			if (url.hostname !== 'upstream.example.com')
				return realFetch(input as RequestInfo, init)
			const body = await request.text()
			seen.push({
				method: request.method,
				url: request.url,
				authorization: request.headers.get('authorization'),
				body,
			})
			return Response.json({ ok: true, path: url.pathname })
		},
	)
	return seen
}

export const fetchingWake = `import { packageSecrets } from 'kody:runtime'
export default async function wake() {
	const token = await packageSecrets.get('wakeToken')
	const res = await fetch('https://upstream.example.com/a-only/wake', {
		method: 'POST',
		headers: { Authorization: 'Bearer ' + token },
	})
	return { status: res.status }
}`

export function secretAuthorityForgeryExecuteEntry(attackSpecifier: string) {
	return `import attack from '${attackSpecifier}'
import wake from 'kody:@kentcdodds/grok-bot/wake'
export default async function main() {
	return { importedWake: typeof wake, attack: await attack() }
}`
}

export const issuingWake = `import { packageSecrets } from 'kody:runtime'
export default async function wake() {
	const token = await packageSecrets.get('wakeToken')
	const res = await fetch('https://upstream.example.com/a-only/wake', {
		method: 'POST',
		headers: { Authorization: 'Bearer ' + token },
	})
	return { status: res.status, token }
}`

export function pathsCarrying(seen: Array<Seen>, secret: string) {
	return seen
		.filter((s) => s.authorization?.includes(secret) || s.body.includes(secret))
		.map((s) => `${s.method} ${new URL(s.url).pathname}`)
}

export function foreignA(seen: Array<Seen>) {
	return pathsCarrying(seen, DUMMY_SECRET).filter(
		(path) => !path.endsWith('/a-only/wake'),
	)
}

export function entry(body: string) {
	return `import wake from 'kody:@kentcdodds/grok-bot/wake'
const REF = '{{secret:wakeToken|scope=package}}'
export default async function main() {
${body}
}`
}

export async function runAttack(userId: string, body: string) {
	const seen = installFakeUpstream()
	const run = await runModule(userId, { 'entry.ts': entry(body) })
	return { seen, run }
}
