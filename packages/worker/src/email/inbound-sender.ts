import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { type InboundEmailSender } from '#worker/request-context/request-context.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { normalizeEmailAddress } from './address.ts'
import {
	failedSenderAuthenticationReason,
	resolveInboundEmailAuthVerdict,
	type EmailAuthVerdict,
} from './auth-verdict.ts'
import { type EmailMessageRecord } from './types.ts'

export type InboundEmailSenderClassification =
	| InboundEmailSender
	| { kind: 'unverified'; reason: string }

type SenderAccountRow = {
	stable_user_id: string
	username: string
	email_verified_at: string | null
	suspended_at: string | null
	deleting_at: string | null
}

function addressDomain(address: string | null) {
	if (!address) return null
	const at = address.lastIndexOf('@')
	return at === -1 ? null : address.slice(at + 1)
}

/**
 * A member identity needs the From address itself authenticated. DMARC pass
 * already requires alignment with the From domain. Without it, only SPF pass
 * on an envelope sender in the From domain counts. A DKIM pass alone does not:
 * the signing domain is not parsed, so it may belong to anyone, and the
 * envelope sender is attacker-chosen unless SPF vouches for it.
 */
export function authenticatesFromAddress(input: {
	verdict: EmailAuthVerdict
	fromAddress: string
	envelopeFrom: string | null
}) {
	if (!input.verdict.authenticated) return false
	if (input.verdict.dmarc === 'pass') return true
	if (input.verdict.spf !== 'pass') return false
	const envelopeDomain = addressDomain(
		input.envelopeFrom ? normalizeEmailAddress(input.envelopeFrom) : null,
	)
	return (
		envelopeDomain !== null &&
		envelopeDomain === addressDomain(input.fromAddress)
	)
}

async function loadSenderAccount(db: D1Database, address: string) {
	return await db
		.prepare(
			`SELECT stable_user_id, username, email_verified_at, suspended_at,
			        deleting_at
			 FROM users
			 WHERE email = ?${andLiveDeletedAtSql()}
			 LIMIT 1`,
		)
		.bind(address)
		.first<SenderAccountRow>()
}

/**
 * Decide who an inbound email to an org's inbox runs as.
 *
 * - The existing auth verdict (#984) gates everything: a suspect message is
 *   unverified and runs nothing.
 * - A From address that is the account email of a current member of the org
 *   is a member claim. It runs as that member only when the account email is
 *   verified, the account is live, and the From address authenticated.
 *   Otherwise it is a spoofed or unverified member address and runs nothing;
 *   it never falls back to the inbox owner.
 * - Any other sender runs as `inbox-owner` only when the From address
 *   itself authenticated (DMARC pass or aligned SPF). A DKIM pass alone
 *   does not. Packages still run only through a matching sender rule;
 *   this kind does not fall back to an inbox-owner enablement.
 */
export async function classifyInboundEmailSender(input: {
	db: D1Database
	/** The org that owns the inbox (`email_messages.user_id`). */
	orgId: string
	message: Pick<
		EmailMessageRecord,
		'fromAddress' | 'envelopeFrom' | 'authResults'
	>
}): Promise<InboundEmailSenderClassification> {
	const verdict = resolveInboundEmailAuthVerdict(input.message.authResults)
	if (verdict.suspect) {
		return {
			kind: 'unverified',
			reason: verdict.reason ?? failedSenderAuthenticationReason,
		}
	}
	const fromAddress = input.message.fromAddress
		? normalizeEmailAddress(input.message.fromAddress)
		: null
	if (!fromAddress) {
		return { kind: 'unverified', reason: 'Message has no From address.' }
	}
	const account = await loadSenderAccount(input.db, fromAddress)
	const binding = account
		? await loadOrgBindingForOrg(input.db, account.stable_user_id, input.orgId)
		: null
	if (!account || !binding?.role) {
		if (
			!authenticatesFromAddress({
				verdict,
				fromAddress,
				envelopeFrom: input.message.envelopeFrom,
			})
		) {
			return {
				kind: 'unverified',
				reason:
					'From address was not authenticated (DMARC pass or aligned SPF is required).',
			}
		}
		return { kind: 'inbox-owner' }
	}
	if (!account.email_verified_at) {
		return {
			kind: 'unverified',
			reason:
				'From address is an org member account email that is not verified.',
		}
	}
	if (account.suspended_at || account.deleting_at) {
		return {
			kind: 'unverified',
			reason: 'From address belongs to a suspended or deleting member account.',
		}
	}
	if (
		!authenticatesFromAddress({
			verdict,
			fromAddress,
			envelopeFrom: input.message.envelopeFrom,
		})
	) {
		return {
			kind: 'unverified',
			reason:
				'From address is an org member account email, but the message did not authenticate it.',
		}
	}
	return {
		kind: 'member',
		actor: {
			userId: personIdFromStored(account.stable_user_id),
			username: account.username?.trim() || null,
		},
		role: binding.role,
	}
}
