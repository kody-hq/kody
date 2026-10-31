import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	type SkillReadChannel,
	type SkillReadEvent,
} from '#universal/skill-metrics.ts'
import {
	type PackageSkillsIndex,
	type PackageSkillIndexEntry,
	type PackageSkillResourceIndexEntry,
	buildSkillUri,
	digestSnapshotContent,
	parseKodyIdForSkillUri,
} from './package-skills.ts'
import { runLogRpc } from '#worker/run-records/service.ts'

/** Called only after authorization and successful content resolution, never by index builders. */
export async function recordSkillRead(input: {
	env: Env
	callerContext: McpCallerContext
	channel: SkillReadChannel
	resource: Pick<
		SkillReadEvent,
		| 'packageId'
		| 'packageName'
		| 'packageOwnerId'
		| 'publishedCommit'
		| 'skillName'
		| 'skillUri'
		| 'filePath'
		| 'digest'
		| 'kind'
	>
	eventId?: string
}) {
	const request = input.callerContext.request
	if (!request) return
	// Analytics only: the content is already authorized and loaded.
	try {
		await runLogRpc({ env: input.env, userId: request.org.id }).recordSkillRead(
			{
				...input.resource,
				id: input.eventId
					? `${request.actor?.userId ?? 'automation'}:${input.channel}:${input.eventId}`
					: crypto.randomUUID(),
				occurredAt: new Date().toISOString(),
				orgId: request.org.id,
				actorId: request.actor?.userId ?? null,
				actorUsername: request.actor?.username ?? null,
				attribution: request.attribution,
				credentialKind: request.credential.kind,
				connectionId: request.credential.id,
				clientId: input.callerContext.oauthClientId ?? null,
				channel: input.channel,
			},
		)
	} catch (error) {
		console.warn('skill-read-record-failed', error)
	}
}

export function catalogReadResource(match: {
	package: { packageId: string; ownerUserId: string; index: PackageSkillsIndex }
	skill: PackageSkillIndexEntry
	resource: PackageSkillResourceIndexEntry
}) {
	return {
		packageId: match.package.packageId,
		packageName: match.package.index.kodyId,
		packageOwnerId: match.package.ownerUserId,
		publishedCommit: match.package.index.publishedCommit,
		skillName: match.skill.name,
		skillUri: match.skill.uri,
		filePath: match.resource.packagePath,
		digest: match.resource.digest,
		kind:
			match.resource.relativePath === 'SKILL.md'
				? ('instructions' as const)
				: ('supporting-file' as const),
	}
}

/** Snapshot and repo APIs can deliver skill files without going through MCP resources. */
export async function recordSkillFileRead(input: {
	env: Env
	callerContext: McpCallerContext
	channel: SkillReadChannel
	packageId: string
	packageName: string
	packageOwnerId: string
	publishedCommit: string | null
	path: string
	content: string
	hasManifest: boolean
	eventId?: string
}) {
	const match = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(.+)$/.exec(input.path)
	if (!match || !input.hasManifest || !input.callerContext.request) return
	const [, skillName, relativePath] = match
	if (!skillName || !relativePath) return
	const { owner, slug } = parseKodyIdForSkillUri(input.packageName)
	const { digest } = await digestSnapshotContent(input.content, input.path)
	await recordSkillRead({
		...input,
		resource: {
			packageId: input.packageId,
			packageName: input.packageName,
			packageOwnerId: input.packageOwnerId,
			publishedCommit: input.publishedCommit,
			skillName,
			skillUri: buildSkillUri([owner, slug], `${skillName}/SKILL.md`),
			filePath: input.path,
			digest,
			kind: relativePath === 'SKILL.md' ? 'instructions' : 'supporting-file',
		},
	})
}

export type SkillReadResource = Parameters<
	typeof recordSkillRead
>[0]['resource']

export async function skillFileReadResource(input: {
	packageId: string
	packageName: string
	packageOwnerId: string
	publishedCommit: string | null
	files: Record<string, string>
	path: string
}): Promise<SkillReadResource | null> {
	const skillName = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\//.exec(
		input.path,
	)?.[1]
	const content = input.files[input.path]
	if (
		!skillName ||
		content === undefined ||
		input.files[`skills/${skillName}/SKILL.md`] === undefined
	)
		return null
	const { owner, slug } = parseKodyIdForSkillUri(input.packageName)
	return {
		packageId: input.packageId,
		packageName: input.packageName,
		packageOwnerId: input.packageOwnerId,
		publishedCommit: input.publishedCommit,
		skillName,
		skillUri: buildSkillUri([owner, slug], `${skillName}/SKILL.md`),
		filePath: input.path,
		digest: (await digestSnapshotContent(content, input.path)).digest,
		kind:
			input.path === `skills/${skillName}/SKILL.md`
				? 'instructions'
				: 'supporting-file',
	}
}

// A receipt binds a displayed snapshot to its actor, even if a new version is
// published before the browser acknowledges it. No authored content is stored.
type Receipt = {
	resource: SkillReadResource
	actorId: string
	orgId: string
	expires: number
	channel: 'skills-page' | 'package-file'
}
async function receiptKey(secret: string) {
	return crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	)
}
export async function issueSkillReadReceipt(
	secret: string,
	input: Omit<Receipt, 'expires'>,
) {
	const payload = btoa(
		JSON.stringify({ ...input, expires: Date.now() + 24 * 3600000 }).replace(
			/[\u007f-\uffff]/g,
			(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
		),
	)
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			'HMAC',
			await receiptKey(secret),
			new TextEncoder().encode(`skill-read:${payload}`),
		),
	)
	return `${payload}.${btoa(String.fromCharCode(...signature))}`
}
export async function verifySkillReadReceipt(
	secret: string,
	token: string,
): Promise<Receipt> {
	const [payload, signature, extra] = token.split('.')
	if (!payload || !signature || extra)
		throw new Error('Invalid skill read receipt.')
	const valid = await crypto.subtle.verify(
		'HMAC',
		await receiptKey(secret),
		Uint8Array.from(atob(signature), (c) => c.charCodeAt(0)),
		new TextEncoder().encode(`skill-read:${payload}`),
	)
	if (!valid) throw new Error('Invalid skill read receipt.')
	const receipt = JSON.parse(atob(payload)) as Receipt
	if (receipt.expires < Date.now())
		throw new Error('Skill read receipt expired. Reload the file.')
	return receipt
}
