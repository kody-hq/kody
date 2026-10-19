import {
	hasHigherPublicPlan,
	type CreditWalletState,
	type EntitlementResource,
	type PlanName,
} from '#universal/plans.ts'
import { entitlementCreditsOffer } from './errors.ts'

export type EntitlementResourceGroup =
	| 'monthly'
	| 'daily'
	| 'counts'
	| 'storage'
	| 'limits'

export type EntitlementResourceVisibilityKind = 'counter' | 'per_unit_max'

export const entitlementResourceGroupLabels: Record<
	EntitlementResourceGroup,
	string
> = {
	monthly: 'Monthly compute',
	daily: 'Daily rates',
	counts: 'Resource counts',
	storage: 'Storage',
	limits: 'Per-item limits',
}

export const entitlementResourceGroupNotes: Partial<
	Record<EntitlementResourceGroup, string>
> = {
	monthly:
		'Included Worker compute and Rows read this UTC month. On Pro, usage past the include is charged from prepaid credits and stops when they run out; Free is asked to upgrade.',
	daily:
		'Daily counters reset at UTC midnight. Unique execute workers and outbound fetches also have a this-week cap (UTC Monday–Sunday). High daily headroom for bursts; weekly total keeps it sustainable.',
}

export type EntitlementResourceVisibility = {
	group: EntitlementResourceGroup
	kind: EntitlementResourceVisibilityKind
	whatCounts: string
	/**
	 * Reduce-usage guidance without a self-serve upgrade clause. Always ends
	 * with a period.
	 */
	howToReduce: string
	/**
	 * Mid-sentence upgrade offer (leading comma). Joined onto
	 * {@link howToReduce} when {@link hasHigherPublicPlan} is true.
	 */
	upgradeOffer?: string
}

/**
 * Plain-language copy for account usage UI and the `usageGet` capability.
 * Keep factual and terse; update when enforcement semantics change.
 * Prefer {@link buildEntitlementHowToReduce} over reading `howToReduce`
 * directly so Pro/Max never get a dead-end upgrade clause.
 */
export const entitlementResourceVisibility: Record<
	EntitlementResource,
	EntitlementResourceVisibility
> = {
	repos: {
		group: 'counts',
		kind: 'counter',
		whatCounts: 'Plain repos you created for package and agent work.',
		howToReduce: 'Delete repos you no longer need.',
	},
	saved_packages: {
		group: 'counts',
		kind: 'counter',
		whatCounts: 'Saved packages published to your account.',
		howToReduce:
			'Delete unused packages from the package page or with packageDelete.',
	},
	scheduled_jobs: {
		group: 'counts',
		kind: 'counter',
		whatCounts: 'Scheduled jobs waiting to run on a schedule.',
		howToReduce: 'Delete jobs you no longer need.',
	},
	repo_sessions: {
		group: 'counts',
		kind: 'counter',
		whatCounts: 'Active editing sessions opened by agents against your repos.',
		howToReduce:
			'Discard finished sessions with repoDiscardSession. Unused (never-checkpointed) sessions are swept after 30 minutes idle; checkpointed sessions are swept after 7 days idle. Successful publish releases session scratch from storage counts; the catalog row is retained for 14 days.',
	},
	email_sends_per_day: {
		group: 'daily',
		kind: 'counter',
		whatCounts: 'Outbound email send attempts today (UTC).',
		howToReduce: 'Send fewer messages today.',
		upgradeOffer: ', or upgrade your plan.',
	},
	email_receives_per_day: {
		group: 'daily',
		kind: 'counter',
		whatCounts: 'Inbound email messages accepted for storage today (UTC).',
		howToReduce: 'Reduce inbound volume (filters, fewer public addresses).',
		upgradeOffer: ', or upgrade your plan.',
	},
	stored_email_messages: {
		group: 'counts',
		kind: 'counter',
		whatCounts: 'Email messages stored in your mailboxes.',
		howToReduce:
			'Delete messages you no longer need from /account/email, or with emailMessageDelete.',
	},
	email_message_bytes: {
		group: 'limits',
		kind: 'per_unit_max',
		whatCounts:
			'Maximum raw MIME persisted for a single email. Larger inbound mail is stored with text kept and oversized parts omitted, up to the 25 MiB Email Routing ceiling.',
		howToReduce: 'Keep attachments and bodies smaller.',
		upgradeOffer: ', or upgrade for a higher persist cap.',
	},
	secrets: {
		group: 'counts',
		kind: 'counter',
		whatCounts: 'Secret entries in non-expired secret buckets.',
		howToReduce: 'Delete secrets you no longer need.',
	},
	storage_bytes: {
		group: 'storage',
		kind: 'counter',
		whatCounts:
			'Durable payload bytes across D1-backed data plus inventoried package, job, execute, and active repo-session storage buckets. Successful repoPublishSession releases that session’s scratch so it no longer counts; active sessions and package/job storage still do.',
		howToReduce:
			'Delete package or job storage you no longer need, discard active repo sessions with repoDiscardSession, or clear package storage from the package page. usageGet / Account → Usage list inventoried bucket kinds when storage is high.',
	},
	concurrent_workflows: {
		group: 'counts',
		kind: 'counter',
		whatCounts: 'Workflow runs currently active on your account.',
		howToReduce:
			'Wait for workflows to finish or cancel runs you no longer need.',
	},
	execute_unique_workers_per_day: {
		group: 'daily',
		kind: 'counter',
		whatCounts:
			'Distinct code your MCP execute calls ran today (UTC). Each new module graph loads one sandbox worker and counts once per day; running the same code again (any params, success or failure) is free. Calls that never load a worker (refused before running) do not count. Does not include webhooks, package-export HTTP invocations, subscriptions, or jobs. Public plans also cap the UTC week.',
		howToReduce:
			'Reuse the same code and vary params instead of writing new code for each call.',
		upgradeOffer: ', or upgrade your plan.',
	},
	outbound_fetches_per_day: {
		group: 'daily',
		kind: 'counter',
		whatCounts:
			'Sandbox outbound HTTP fetches through the fetch gateway today (UTC). Public plans also cap the UTC week.',
		howToReduce: 'Fetch less from user code today or this week.',
		upgradeOffer: ', or upgrade your plan.',
	},
	job_runs_per_day: {
		group: 'daily',
		kind: 'counter',
		whatCounts:
			'Scheduled job executions today (UTC), including failed attempts and run-now. Separate from automation invocations (webhooks / package exports).',
		howToReduce: 'Run fewer jobs today, space them out.',
		upgradeOffer: ', or upgrade your plan.',
	},
	automation_invocations_per_day: {
		group: 'daily',
		kind: 'counter',
		whatCounts:
			'Always-on automation entrypoints today (UTC): inbound webhooks, HTTP package-export invocations, package subscriptions, and package-backed workflow steps. Separate from MCP execute and scheduled job runs.',
		howToReduce: 'Trigger fewer webhooks or package invocations today.',
		upgradeOffer: ', or upgrade your plan.',
	},
	execute_calls_per_minute: {
		group: 'daily',
		kind: 'counter',
		whatCounts:
			'Hosted execute calls started in the last UTC minute (repeats and failures included). A runaway safety net, not a billed quota; seats raise the org limit.',
		howToReduce:
			'Slow down or stop a looping agent; change code or params so calls are not identical.',
	},
}

/**
 * Plan-aware reduce-usage guidance for account usage UI, `usageGet`, and
 * warning emails. Rate/compute includes use the same credits next step as
 * denials ({@link entitlementCreditsOffer}). Other resources (including
 * stock, which ships with purchasable Pro) keep the upgrade clause only
 * while a higher public plan exists (Free).
 */
export function buildEntitlementHowToReduce(
	resource: EntitlementResource,
	plan: PlanName,
	creditWallet: CreditWalletState = 'none',
) {
	const visibility = entitlementResourceVisibility[resource]
	const { howToReduce, upgradeOffer } = visibility
	const creditsOffer = entitlementCreditsOffer(resource, plan, creditWallet)
	if (!creditsOffer && (!upgradeOffer || !hasHigherPublicPlan(plan))) {
		return howToReduce
	}
	if (!howToReduce.endsWith('.')) {
		throw new Error(
			`Entitlement howToReduce for ${resource} must end with a period.`,
		)
	}
	const offer = creditsOffer ? `, or ${creditsOffer}.` : upgradeOffer
	return `${howToReduce.slice(0, -1)}${offer}`
}

/** All entitlement resources in display order (grouped). */
export const accountUsageEntitlementResources = [
	'email_sends_per_day',
	'email_receives_per_day',
	'execute_unique_workers_per_day',
	'outbound_fetches_per_day',
	'job_runs_per_day',
	'automation_invocations_per_day',
	'repos',
	'saved_packages',
	'scheduled_jobs',
	'repo_sessions',
	'stored_email_messages',
	'secrets',
	'concurrent_workflows',
	'storage_bytes',
	'email_message_bytes',
] as const satisfies ReadonlyArray<EntitlementResource>

export const entitlementResourceGroupOrder: Array<EntitlementResourceGroup> = [
	'monthly',
	'daily',
	'counts',
	'storage',
	'limits',
]
