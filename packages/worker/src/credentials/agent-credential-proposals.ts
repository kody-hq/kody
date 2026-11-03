/**
 * Agent credential mapping proposals (ADR 0068 amendment 2026-10-13, "How
 * picks change"). An agent is the person it acts for plus the request
 * credential it called with. Its proposals are recorded; when that same
 * person approves one through its link, the trigger picks they approved are
 * recorded too. `credentialTriggerPickSet` may set a trigger pick only to one
 * of those approved values, so no pick changes without a person's approval.
 */
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import type {
	CredentialTriggerKind,
	ParsedCredentialProposal,
} from '#universal/credential-contracts.ts'
import type { ResolvedMappingChange } from './package-credential-mapping-changes.ts'
import type { PackageMappingScope } from './package-credential-mappings.ts'

const agentCredentialKinds = ['mcp-oauth', 'cli', 'api-token'] as const

type AgentCredentialKind = (typeof agentCredentialKinds)[number]

export type ProposingAgent = {
	personId: string
	credentialKind: AgentCredentialKind
	credentialId: string
}

/** A trigger pick as a person approved it: credential ids, in order. */
export type ApprovedTriggerPick = {
	trigger: { kind: CredentialTriggerKind; name: string }
	/** The webhook endpoint (or job, or package) the approval was for. */
	instanceId: string | null
	needKey: string
	credentialIds: Array<string>
}

/** Unapproved proposals are dropped after this long. */
const pendingProposalTtlMs = 30 * 24 * 60 * 60 * 1000

function isAgentCredentialKind(kind: string): kind is AgentCredentialKind {
	return (agentCredentialKinds as ReadonlyArray<string>).includes(kind)
}

/**
 * The agent behind a request: a signed-in person calling through an MCP
 * OAuth client, the CLI, or an API token. Null for a browser session, a
 * triggered run, or a client with no id, which cannot be told apart from
 * another agent.
 */
export function proposingAgentFor(
	request: RequestContext,
): ProposingAgent | null {
	const personId = request.actor?.userId
	const { kind, id } = request.credential
	if (!personId || !id || !isAgentCredentialKind(kind)) return null
	return { personId, credentialKind: kind, credentialId: id }
}

function proposalJson(proposal: ParsedCredentialProposal) {
	return JSON.stringify({
		changes: proposal.changes,
		enable: proposal.enable,
		reason: proposal.reason,
		// Omit a null sender so proposals recorded before sender existed still match.
		...(proposal.sender ? { sender: proposal.sender } : {}),
	})
}

/** Records a proposal under the agent that made it; returns its id. */
export async function recordCredentialProposal(input: {
	db: D1Database
	orgId: string
	packageId: string
	agent: ProposingAgent
	proposal: ParsedCredentialProposal
	now?: Date
}): Promise<string> {
	const now = input.now ?? new Date()
	const id = crypto.randomUUID()
	const { agent } = input
	await input.db.batch([
		input.db
			.prepare(
				`DELETE FROM credential_mapping_proposals
				WHERE org_id = ? AND package_id = ? AND person_user_id = ?
					AND agent_credential_kind = ? AND agent_credential_id = ?
					AND approved_at IS NULL AND created_at < ?`,
			)
			.bind(
				input.orgId,
				input.packageId,
				agent.personId,
				agent.credentialKind,
				agent.credentialId,
				new Date(now.getTime() - pendingProposalTtlMs).toISOString(),
			),
		input.db
			.prepare(
				`INSERT INTO credential_mapping_proposals (
					id, org_id, package_id, person_user_id, agent_credential_kind,
					agent_credential_id, proposal_json, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				input.orgId,
				input.packageId,
				agent.personId,
				agent.credentialKind,
				agent.credentialId,
				proposalJson(input.proposal),
				now.toISOString(),
			),
	])
	return id
}

/**
 * The statement that records, on the recorded proposal `proposalId`, the
 * trigger picks an Approve applies, for the caller to write in the same batch
 * as the mappings. Only the person the agent proposed for can approve picks
 * the agent may later set, and only for exactly what was proposed: an edited
 * link, another org or package, or another approver records nothing (null).
 * Picks approved earlier on the same proposal stay approved.
 */
export async function planCredentialProposalApproval(input: {
	scope: PackageMappingScope
	proposalId: string
	proposal: ParsedCredentialProposal
	resolved: ReadonlyArray<ResolvedMappingChange>
	now?: Date
}): Promise<D1PreparedStatement | null> {
	const { scope } = input
	const db = scope.env.APP_DB
	const row = await db
		.prepare(
			`SELECT proposal_json, approved_picks_json
			FROM credential_mapping_proposals
			WHERE id = ? AND org_id = ? AND package_id = ? AND person_user_id = ?`,
		)
		.bind(
			input.proposalId,
			scope.request.org.id,
			scope.savedPackage.id,
			scope.actorId,
		)
		.first<{ proposal_json: string; approved_picks_json: string | null }>()
	if (!row || row.proposal_json !== proposalJson(input.proposal)) return null
	const picks = parsePicks(row.approved_picks_json ?? '[]')
	for (const change of input.resolved) {
		if (change.target.type !== 'trigger' || !change.credentialIds) continue
		const pick: ApprovedTriggerPick = {
			trigger: change.target.trigger,
			instanceId: change.trigger?.instanceId ?? null,
			needKey: change.needKey,
			credentialIds: change.credentialIds,
		}
		if (!picks.some((approved) => samePick(approved, pick))) picks.push(pick)
	}
	return db
		.prepare(
			`UPDATE credential_mapping_proposals
			SET approved_picks_json = ?, approved_at = ?
			WHERE id = ?`,
		)
		.bind(
			JSON.stringify(picks),
			(input.now ?? new Date()).toISOString(),
			input.proposalId,
		)
}

function parsePicks(json: string): Array<ApprovedTriggerPick> {
	try {
		const parsed: unknown = JSON.parse(json)
		return Array.isArray(parsed) ? (parsed as Array<ApprovedTriggerPick>) : []
	} catch {
		return []
	}
}

function samePick(a: ApprovedTriggerPick, b: ApprovedTriggerPick) {
	return (
		a.trigger.kind === b.trigger.kind &&
		a.trigger.name === b.trigger.name &&
		a.instanceId === b.instanceId &&
		a.needKey === b.needKey &&
		a.credentialIds.length === b.credentialIds.length &&
		a.credentialIds.every((id, index) => id === b.credentialIds[index])
	)
}

/** Whether this agent proposed `pick` and its person approved it. */
export async function agentHasApprovedPick(input: {
	db: D1Database
	orgId: string
	packageId: string
	agent: ProposingAgent
	pick: ApprovedTriggerPick
}): Promise<boolean> {
	const { agent } = input
	const { results } = await input.db
		.prepare(
			`SELECT approved_picks_json FROM credential_mapping_proposals
			WHERE org_id = ? AND package_id = ? AND person_user_id = ?
				AND agent_credential_kind = ? AND agent_credential_id = ?
				AND approved_at IS NOT NULL`,
		)
		.bind(
			input.orgId,
			input.packageId,
			agent.personId,
			agent.credentialKind,
			agent.credentialId,
		)
		.all<{ approved_picks_json: string | null }>()
	return results.some((row) =>
		parsePicks(row.approved_picks_json ?? '[]').some((approved) =>
			samePick(approved, input.pick),
		),
	)
}

export type RecordedCredentialProposal = {
	id: string
	orgId: string
	packageId: string
	personId: string
	agentCredentialKind: string
	agentCredentialId: string
	proposal: ParsedCredentialProposal
	approvedAt: string | null
	createdAt: string
}

/** The proposal as `credentialMappingPropose` recorded it; null when unreadable. */
function readRecordedProposal(json: string): ParsedCredentialProposal | null {
	try {
		const parsed = JSON.parse(json) as Partial<
			Pick<ParsedCredentialProposal, 'changes' | 'enable' | 'reason'>
		> & { sender?: ParsedCredentialProposal['sender'] }
		if (!Array.isArray(parsed.changes) || !Array.isArray(parsed.enable)) {
			return null
		}
		return {
			changes: parsed.changes,
			enable: parsed.enable,
			reason: typeof parsed.reason === 'string' ? parsed.reason : null,
			sender: parsed.sender ?? null,
			errors: [],
		}
	} catch {
		return null
	}
}

function mapRecordedProposal(
	row: Record<string, unknown>,
): RecordedCredentialProposal | null {
	const proposal = readRecordedProposal(String(row['proposal_json']))
	if (!proposal) return null
	return {
		id: String(row['id']),
		orgId: String(row['org_id']),
		packageId: String(row['package_id']),
		personId: String(row['person_user_id']),
		agentCredentialKind: String(row['agent_credential_kind']),
		agentCredentialId: String(row['agent_credential_id']),
		proposal,
		approvedAt: row['approved_at'] == null ? null : String(row['approved_at']),
		createdAt: String(row['created_at']),
	}
}

const recordedProposalColumns = `id, org_id, package_id, person_user_id,
	agent_credential_kind, agent_credential_id, proposal_json, approved_at,
	created_at`

/** One recorded proposal made for `personId` in `orgId`. */
export async function getRecordedCredentialProposal(input: {
	db: D1Database
	id: string
	orgId: string
	personId: string
}): Promise<RecordedCredentialProposal | null> {
	const row = await input.db
		.prepare(
			`SELECT ${recordedProposalColumns} FROM credential_mapping_proposals
			WHERE id = ? AND org_id = ? AND person_user_id = ?`,
		)
		.bind(input.id, input.orgId, input.personId)
		.first<Record<string, unknown>>()
	return row ? mapRecordedProposal(row) : null
}

/**
 * Unapproved proposals made for `personId` in `orgId` within the pending
 * window, newest first. The same proposal recorded twice for a package by the
 * same agent appears once, as its newest record, and not at all once that
 * newest record is approved. Approvals are scoped to the proposing agent, so
 * equal proposals from different agents stay separate.
 */
export async function listPendingCredentialProposals(input: {
	db: D1Database
	orgId: string
	personId: string
	now?: Date
}): Promise<Array<RecordedCredentialProposal>> {
	const now = input.now ?? new Date()
	const { results } = await input.db
		.prepare(
			`SELECT ${recordedProposalColumns} FROM credential_mapping_proposals
			WHERE org_id = ? AND person_user_id = ? AND created_at >= ?
			ORDER BY created_at DESC, id`,
		)
		.bind(
			input.orgId,
			input.personId,
			new Date(now.getTime() - pendingProposalTtlMs).toISOString(),
		)
		.all<Record<string, unknown>>()
	const seen = new Set<string>()
	const proposals: Array<RecordedCredentialProposal> = []
	for (const row of results ?? []) {
		const dedupeKey = JSON.stringify([
			row['package_id'],
			row['agent_credential_kind'],
			row['agent_credential_id'],
			row['proposal_json'],
		])
		if (seen.has(dedupeKey)) continue
		seen.add(dedupeKey)
		if (row['approved_at'] != null) continue
		const recorded = mapRecordedProposal(row)
		if (recorded) proposals.push(recorded)
	}
	return proposals
}

/** A member leaving an org takes their agents' proposals with them. */
export async function deleteCredentialProposalsForMember(input: {
	db: D1Database
	orgId: string
	personId: string
}) {
	const result = await input.db
		.prepare(
			`DELETE FROM credential_mapping_proposals
			WHERE org_id = ? AND person_user_id = ?`,
		)
		.bind(input.orgId, input.personId)
		.run()
	return result.meta?.changes ?? 0
}
