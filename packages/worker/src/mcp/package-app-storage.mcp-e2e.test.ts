import { expect, test } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
	createAppSessionCookie,
	createMcpClient,
	createUniqueTestUser,
	getSharedMcpE2eServer,
} from '../../../../tools/mcp-test-support.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'

const kodyId = 'app-storage-smoke'
const markerKey = 'smoke-marker'
const markerValue = 'package-storage-ok'
const tableName = 'app_storage_smoke'

type ExecuteStructured = {
	result?: unknown
	error?: unknown
}

type PackageSaveResult = {
	package_id: string
	kody_id: string
	has_app: boolean
}

type AppStorageResponse = {
	bucketId: string
	read: unknown
	sqlRows: Array<Record<string, unknown>>
	packageContext: {
		appBasePath: string
		hostedUrl: string
	}
}

function readExecuteResult<T>(toolResult: CallToolResult): T {
	expect(toolResult.isError).toBeFalsy()
	const structured = toolResult.structuredContent as ExecuteStructured
	expect(structured.error).toBeUndefined()
	expect(structured.result).toBeTruthy()
	return structured.result as T
}

function buildPackageFiles(username: string) {
	const packageJson = {
		name: `@${username}/${kodyId}`,
		private: true,
		exports: { '.': './src/index.ts' },
		kody: {
			id: kodyId,
			description: 'MCP e2e smoke package for packageStorage in app fetch',
			app: {
				entry: './src/app.ts',
			},
		},
	}
	return [
		{
			path: 'package.json',
			content: `${JSON.stringify(packageJson, null, '\t')}\n`,
		},
		{
			path: 'README.md',
			content:
				'# App storage smoke\n\n## Intent\n\nProve package app fetch handlers can use packageStorage() end-to-end.\n',
		},
		{
			path: 'AGENTS.md',
			content:
				'# Agents\n\nImport the app-storage smoke export and call packageAppFetch.\n',
		},
		{
			path: 'src/index.ts',
			content:
				'export default async function main() {\n\treturn { ok: true }\n}\n',
		},
		{
			path: 'src/app.ts',
			content: `import { packageContext, packageStorage } from 'kody:runtime'

export default {
	async fetch() {
		const storage = packageStorage()
		await storage.set(${JSON.stringify(markerKey)}, ${JSON.stringify(markerValue)})
		const read = await storage.get(${JSON.stringify(markerKey)})
		await storage.sql(
			'CREATE TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL)',
		)
		await storage.sql('INSERT INTO ${tableName} (note) VALUES (?)', [
			${JSON.stringify(markerValue)},
		])
		const sqlResult = await storage.sql(
			'SELECT id, note FROM ${tableName} ORDER BY id ASC',
		)
		return Response.json({
			bucketId: storage.id,
			read,
			sqlRows: sqlResult.rows,
			packageContext,
		}, { status: 201 })
	},
}
`,
		},
	]
}

test('package app fetch handler can use packageStorage against a real local worker', async () => {
	silenceExpectedConsoleWarns([
		/Ignoring duplicate module:.*generated\/esbuild\.wasm/,
	])
	const server = await getSharedMcpE2eServer()
	const user = createUniqueTestUser()
	await using mcp = await createMcpClient(server.origin, user, {
		ensureUser: server.ensureUser,
		markEmailVerified: server.markEmailVerified,
		clearAuthRateLimits: server.clearAuthRateLimits,
	})
	const { username } = user
	const files = buildPackageFiles(username)
	let packageId: string | undefined

	try {
		const saveResult = await mcp.client.callTool({
			name: 'execute',
			arguments: {
				code: `import { kody } from 'kody:runtime'
export default async function main(input) {
	return await kody.packageSave({ files: input.files })
}
`,
				params: { files },
			},
		})
		const saved = readExecuteResult<PackageSaveResult>(
			saveResult as CallToolResult,
		)
		expect(saved.kody_id).toBe(kodyId)
		expect(saved.has_app).toBe(true)
		packageId = saved.package_id
		const expectedBucketId = `package:${encodeURIComponent(packageId)}`

		const cookie = await createAppSessionCookie(server.origin, user)
		const appBasePath = `/@${username}/packages/${kodyId}`
		const appUrl = `${server.origin}${appBasePath}?audio=1`

		const firstResponse = await fetch(appUrl, {
			headers: { Cookie: cookie, Accept: 'application/json' },
			redirect: 'follow',
		})
		const firstBodyText = await firstResponse.text()
		expect(
			firstResponse.status,
			`first app fetch failed: ${firstBodyText}`,
		).toBe(201)
		const firstBody = JSON.parse(firstBodyText) as AppStorageResponse
		expect(firstBody.bucketId).toBe(expectedBucketId)
		expect(firstBody.read).toBe(markerValue)
		expect(firstBody.sqlRows).toEqual([{ id: 1, note: markerValue }])
		expect(firstBody.packageContext).toMatchObject({
			appBasePath,
			hostedUrl: `${server.origin}${appBasePath}`,
		})

		const secondResponse = await fetch(appUrl, {
			headers: { Cookie: cookie, Accept: 'application/json' },
			redirect: 'follow',
		})
		const secondBodyText = await secondResponse.text()
		expect(
			secondResponse.status,
			`second app fetch failed: ${secondBodyText}`,
		).toBe(201)
		const secondBody = JSON.parse(secondBodyText) as AppStorageResponse
		expect(secondBody.bucketId).toBe(expectedBucketId)
		expect(secondBody.read).toBe(markerValue)
		expect(secondBody.sqlRows).toEqual([
			{ id: 1, note: markerValue },
			{ id: 2, note: markerValue },
		])

		const queryResult = await mcp.client.callTool({
			name: 'execute',
			arguments: {
				code: `import { kody } from 'kody:runtime'
export default async function main(input) {
	return await kody.storageQuery({
		storage_id: input.storageId,
		query: input.query,
	})
}
`,
				params: {
					storageId: expectedBucketId,
					query: `SELECT id, note FROM ${tableName} ORDER BY id ASC`,
				},
			},
		})
		const queried = readExecuteResult<{
			rows: Array<Record<string, unknown>>
			row_count: number
		}>(queryResult as CallToolResult)
		expect(queried.row_count).toBe(2)
		expect(queried.rows).toEqual([
			{ id: 1, note: markerValue },
			{ id: 2, note: markerValue },
		])
	} finally {
		if (packageId) {
			await mcp.client.callTool({
				name: 'execute',
				arguments: {
					code: `import { kody } from 'kody:runtime'
export default async function main(input) {
	return await kody.packageDelete({
		package_id: input.packageId,
		confirm_name: input.confirmName,
	})
}
`,
					params: { packageId, confirmName: `@${username}/${kodyId}` },
				},
			})
		}
	}
}, 120_000)
