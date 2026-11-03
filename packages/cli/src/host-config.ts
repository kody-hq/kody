import { dirname } from 'node:path'

const leftoverHostIds = [
	'amazon-q',
	'qwen-code',
	'visual-studio',
	'vscode-insiders',
] as const

export type LeftoverHostId = (typeof leftoverHostIds)[number]

function asObject(value: unknown, label: string): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>
	}
	throw new Error(`${label} must be a JSON object.`)
}

function nestedObject(
	parent: Record<string, unknown>,
	key: string,
): Record<string, unknown> {
	const current = parent[key]
	if (current == null) {
		const next = {}
		parent[key] = next
		return next
	}
	return asObject(current, key)
}

function leftoverRemoteEntry(
	id: LeftoverHostId,
	mcpUrl: string,
): Record<string, unknown> {
	switch (id) {
		case 'vscode-insiders':
		case 'visual-studio':
		case 'amazon-q':
			return { type: 'http', url: mcpUrl }
		case 'qwen-code':
			return { httpUrl: mcpUrl }
		default: {
			const exhaustive: never = id
			return exhaustive
		}
	}
}

function jsonRootKey(id: LeftoverHostId): 'mcpServers' | 'servers' {
	switch (id) {
		case 'vscode-insiders':
		case 'visual-studio':
			return 'servers'
		case 'amazon-q':
		case 'qwen-code':
			return 'mcpServers'
		default: {
			const exhaustive: never = id
			return exhaustive
		}
	}
}

function sameRemoteUrl(entry: unknown, mcpUrl: string): boolean {
	if (!entry || typeof entry !== 'object') return false
	const record = entry as Record<string, unknown>
	const candidates = [record.url, record.serverUrl, record.httpUrl, record.uri]
	return candidates.some((value) => value === mcpUrl)
}

export function mergeHostDocument(input: {
	id: LeftoverHostId
	existing: string | null
	mcpUrl: string
}): { body: string; changed: boolean } {
	const entry = leftoverRemoteEntry(input.id, input.mcpUrl)
	const parsed = input.existing?.trim() ? JSON.parse(input.existing) : {}
	const root = asObject(parsed, 'MCP config')
	const bucket = nestedObject(root, jsonRootKey(input.id))
	const changed = !sameRemoteUrl(bucket.kody, input.mcpUrl)
	bucket.kody = entry
	return { body: `${JSON.stringify(root, null, 2)}\n`, changed }
}

export async function writeMergedConfig(input: {
	path: string
	id: LeftoverHostId
	mcpUrl: string
	readFile: (path: string) => Promise<string | null>
	writeFile: (path: string, body: string) => Promise<void>
	mkdir: (path: string) => Promise<void>
}): Promise<{ path: string; changed: boolean }> {
	const existing = await input.readFile(input.path)
	const merged = mergeHostDocument({
		id: input.id,
		existing,
		mcpUrl: input.mcpUrl,
	})
	if (merged.changed) {
		await input.mkdir(dirname(input.path))
		await input.writeFile(input.path, merged.body)
	}
	return { path: input.path, changed: merged.changed }
}
