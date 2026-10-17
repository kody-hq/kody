import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { countConnectedAgentEcosystems } from '#universal/onboarding-agent-ecosystems.ts'
import { loadInboundMcpConnectionState } from '#worker/connected-mcp-agents.ts'
import { type OAuthGrantListHelpers } from '#worker/oauth-grants.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import { joinOrgsOnPersonalOrgIdSql } from '#worker/orgs/personal-org-sql.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { evaluateSecondAgentStandardGift } from './second-agent-standard-gift.ts'

export const secondAgentGiftCursorKey =
	'maintenance:second-agent-standard-gift:cursor'
const batchSize = 8

/**
 * Repairs missed OAuth-completion evaluations, including existing eligible people.
 * Each tick scans at most eight people. Failures retry on the next sweep wrap.
 * KV is only a scan hint: stale/concurrent cursors can repeat work, while the D1
 * conditional gift write is authoritative and never extends an existing gift.
 */
export async function reconcileSecondAgentStandardGifts(input: {
	env: Env
	now: Date
}) {
	const helpers = await resolveOAuthHelpers<OAuthGrantListHelpers>(input.env)
	if (!helpers || !input.env.OAUTH_KV) {
		throw new Error('Second-agent gift reconciliation requires OAuth storage.')
	}
	const after = (await input.env.OAUTH_KV.get(secondAgentGiftCursorKey)) ?? ''
	const page = await input.env.APP_DB.prepare(
		`SELECT u.stable_user_id FROM users u
		 ${joinOrgsOnPersonalOrgIdSql}
		 WHERE u.stable_user_id > ?
		 ${andLiveDeletedAtSql('u')} ${andLiveDeletedAtSql('o')}
		 AND u.deleting_at IS NULL AND o.deleting_at IS NULL
		 AND o.second_agent_standard_gift_granted_at IS NULL
		 ORDER BY u.stable_user_id LIMIT ?`,
	)
		.bind(after, batchSize)
		.all<{ stable_user_id: string }>()
	let granted = 0
	let failed = 0
	for (const row of page.results) {
		try {
			// Match OAuth completion: all of the person's ecosystems count, but
			// evaluateSecondAgentStandardGift writes only their personal org.
			const inbound = await loadInboundMcpConnectionState(
				helpers,
				ownerIdFromStored(row.stable_user_id),
			)
			if (inbound.listingFailed) throw new Error('OAuth grant listing failed.')
			const result = await evaluateSecondAgentStandardGift({
				db: input.env.APP_DB,
				stableUserId: row.stable_user_id,
				ecosystemCount: countConnectedAgentEcosystems(inbound.agents),
				now: input.now,
			})
			if (result.outcome === 'granted') granted += 1
		} catch (error) {
			failed += 1
			console.warn(
				'second-agent-gift-reconciliation-failed',
				row.stable_user_id,
				error,
			)
		}
	}
	// Advance past failed rows too so one broken listing cannot starve the fleet.
	// An empty tail resets the sweep; a partial page can reset immediately.
	const last = page.results.at(-1)
	await input.env.OAUTH_KV.put(
		secondAgentGiftCursorKey,
		page.results.length === batchSize && last ? last.stable_user_id : '',
	)
	return { scanned: page.results.length, granted, failed }
}
