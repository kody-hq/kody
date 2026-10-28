/** Content-free records. A read is delivery of a file, not proof a skill was followed. */
export type SkillReadChannel =
	| 'skills-page'
	| 'mcp-resource'
	| 'search'
	| 'package-api'
	| 'package-file'
	| 'raw-file'
export type SkillReadEvent = {
	id: string
	occurredAt: string
	orgId: string
	actorId: string | null
	actorUsername: string | null
	attribution:
		| { kind: 'user'; userId: string }
		| { kind: 'automation'; source: string; sourceId: string }
	credentialKind: string
	connectionId: string | null
	clientId: string | null
	profileName: string | null
	channel: SkillReadChannel
	packageId: string
	packageName: string
	packageOwnerId: string
	publishedCommit: string | null
	skillName: string
	skillUri: string
	filePath: string
	digest: string
	kind: 'instructions' | 'supporting-file'
}
export type SkillReadSummary = {
	since: string
	instructionReads: number
	supportingFileReads: number
	readers: number
	topSkills: Array<{
		uri: string
		name: string
		packageName: string
		reads: number
	}>
	dailyReads: Array<{ day: string; skillUri: string | null; reads: number }>
	skillActivity: Array<{ uri: string; reads: number; lastRead: string }>
	recentReads: Array<SkillReadEvent>
}
export type SkillMetrics = SkillReadSummary & {
	skillCount: number
	packageCount: number
}
