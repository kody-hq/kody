import { renderTransactionalEmail } from '#app/email/template.ts'
import { type PlatformFeedbackOutcomeStatus } from '#worker/platform-feedback/types.ts'
import { ERROR_AGENT_PROMPT_ATTR } from '#universal/error-agent-prompt.ts'
import { buildBillingFailureAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import { formatCappedPercent } from '#universal/usage-presentation.ts'

function billingFailurePromptBlocks(
	kind: 'payment_failed' | 'past_due',
	errorMessage: string,
) {
	const prompt = buildBillingFailureAgentPrompt({
		kind,
		errorMessage,
		path: '/account/billing',
	})
	return {
		prompt,
		afterAction: [
			'Paste this prompt into Claude, ChatGPT, Grok, or Cursor so your agent can help.',
			{ kind: 'quote' as const, text: prompt },
		],
	}
}

/**
 * Copy for every transactional email, kept free of runtime dependencies so the
 * messages can be rendered and inspected without a running worker.
 * `appBaseUrl` is the origin the Kody mark and other absolute assets are
 * loaded from.
 */

export function buildVerificationEmail(input: {
	appBaseUrl: string
	verificationUrl: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Verify your email to finish setting up Kody',
		preheader: 'One click and Your agents\u2019 cloud is ready.',
		heading: 'Welcome to Kody',
		body: [
			'Kody is Your agents\u2019 cloud: memory, keys, code, and automations, portable across every MCP host.',
			'Verify your email address to activate your account and get started.',
		],
		action: { label: 'Verify email address', url: input.verificationUrl },
		afterAction: ['This link expires in 24 hours.'],
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote:
			'If you did not create a Kody account, you can safely ignore this email.',
	})
}

export function buildEmailChangeEmail(input: {
	appBaseUrl: string
	currentEmail: string
	newEmail: string
	verificationUrl: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Verify your new Kody email',
		preheader: `Confirm ${input.newEmail} as your Kody account email.`,
		heading: 'Confirm your new email address',
		body: [
			`We received a request to change your Kody account email from ${input.currentEmail} to ${input.newEmail}.`,
			'Verify the new address to make the change take effect.',
		],
		action: { label: 'Verify new email address', url: input.verificationUrl },
		afterAction: ['This link expires in 24 hours.'],
		footnote:
			'If you did not request this change, you can safely ignore this email — your current address stays in place.',
	})
}

export function buildEmailDestinationVerificationEmail(input: {
	appBaseUrl: string
	destinationEmail: string
	verificationUrl: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Verify this Kody email destination',
		preheader: `Confirm ${input.destinationEmail} so emailSend can use it as a to address.`,
		heading: 'Confirm this email destination',
		body: [
			`We received a request to let emailSend use ${input.destinationEmail} as a destination.`,
			'Verify the address to add it. Kody will still send from your platform inbox address, not from this one.',
		],
		action: {
			label: 'Verify email destination',
			url: input.verificationUrl,
		},
		afterAction: ['This link expires in 24 hours.'],
		footnote:
			'If you did not ask to add this address, you can safely ignore this email.',
	})
}

export function buildEmailClaimReleaseEmail(input: {
	appBaseUrl: string
	email: string
	verificationUrl: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Release this email from your Kody account',
		preheader: `Confirm you want to release ${input.email} so it can open a new Kody account.`,
		heading: 'Release this email address',
		body: [
			`${input.email} is still tied to your Kody account, so it cannot be used to create a second account.`,
			'Confirm this link to drop that claim. Your current login email and account identity stay the same.',
		],
		action: { label: 'Release this email', url: input.verificationUrl },
		afterAction: ['This link expires in 24 hours.'],
		footnote:
			'If you did not ask to release this address, you can safely ignore this email — the claim stays in place.',
	})
}

export const userEntitlementWarningKinds = ['approaching', 'reached'] as const

export type UserEntitlementWarningKind =
	(typeof userEntitlementWarningKinds)[number]

/** Unique execute workers resource id; drives the local-execute tip in this mail. */
const executeUniqueWorkersPerDayResource = 'execute_unique_workers_per_day'

export function buildUserEntitlementWarningEmail(input: {
	appBaseUrl: string
	creditsUrl: string
	usageUrl: string
	kind: UserEntitlementWarningKind
	warnings: Array<{
		label: string
		current: number
		limit: number
		percentOfLimit: number
		/** Entitlement resource id; required to gate the local-execute tip. */
		resource?: string
		whatCounts?: string
		howToReduce?: string
		include?: { unitLabel: string }
	}>
}) {
	const lines = input.warnings.map((warning) => {
		const counts = [
			formatEntitlementWarningCount(warning),
			warning.whatCounts,
			warning.howToReduce,
		].filter((part): part is string => Boolean(part && part.trim()))
		return counts.join(' ')
	})
	const copy = entitlementWarningCopy(input.kind)
	const includesExecuteQuota = input.warnings.some(
		(warning) => warning.resource === executeUniqueWorkersPerDayResource,
	)
	const body = [copy.intro, ...lines]
	if (includesExecuteQuota) {
		const localExecuteUrl = new URL(
			'/docs/local-execute',
			input.appBaseUrl,
		).toString()
		body.push(
			`You can often avoid this execute quota by running locally with the CLI when the work does not need to stay on Kody: ${localExecuteUrl}`,
		)
	}
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: copy.subject,
		preheader: copy.preheader,
		heading: copy.heading,
		body,
		action: { label: 'Add credits', url: input.creditsUrl },
		afterAction: [
			`You can also see every limit on your usage page: ${input.usageUrl}`,
		],
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote: copy.footnote,
	})
}

function formatEntitlementWarningCount(warning: {
	label: string
	current: number
	limit: number
	percentOfLimit: number
	include?: { unitLabel: string }
}) {
	const current = warning.current.toLocaleString('en-US')
	const limit = warning.limit.toLocaleString('en-US')
	const percent = formatCappedPercent(warning.percentOfLimit)
	if (!warning.include) {
		return `${warning.label} — ${current} of ${limit} (${percent}).`
	}
	const counts = `${current} of ${limit} ${warning.include.unitLabel}`
	return warning.percentOfLimit >= 1
		? `${warning.label} — this month's include is used up (${counts}).`
		: `${warning.label} — ${percent} of this month's include (${counts}).`
}

function entitlementWarningCopy(kind: UserEntitlementWarningKind) {
	switch (kind) {
		case 'approaching':
			return {
				subject: "You're approaching a Kody plan limit",
				preheader: 'One or more resources on your plan are over 80%.',
				heading: "You're getting close to a plan limit",
				intro:
					'Just a heads-up: one or more resources on your Kody account are over 80% of your current plan.',
				footnote:
					"You're receiving this because your account is approaching a plan limit.",
			}
		case 'reached':
			return {
				subject: "You've reached a Kody plan limit",
				preheader: 'One or more resources on your plan are at 100%.',
				heading: "You've hit a plan limit",
				intro:
					'Just a heads-up: one or more resources on your Kody account are at their current plan limit.',
				footnote:
					"You're receiving this because your account has reached a plan limit.",
			}
		default: {
			const exhaustive: never = kind
			throw new Error(`Unknown entitlement warning kind: ${String(exhaustive)}`)
		}
	}
}

type CampaignUnsubscribe = {
	label: string
	url: string
}

export function buildConnectAgentEmail(input: {
	appBaseUrl: string
	onboardingUrl: string
	unsubscribe?: CampaignUnsubscribe
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Connect the agent you already use',
		preheader: 'Cursor, Claude, ChatGPT, Grok Bot: one connection.',
		heading: 'Connect the agent you already use',
		body: [
			'Your email is verified. Open the agent you already live in and connect Kody as an MCP server.',
			'That one connection is the home: packages of code, memory, secrets, and jobs follow you to every host.',
		],
		action: { label: 'Connect your agent', url: input.onboardingUrl },
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote:
			"You're receiving this because you verified a Kody account and have not connected an agent yet.",
		unsubscribe: input.unsubscribe,
	})
}

function capitalizeCampaignLabel(label: string) {
	if (label === '') return label
	return label.charAt(0).toUpperCase() + label.slice(1)
}

export function buildKeepPackageEmail(input: {
	appBaseUrl: string
	onboardingUrl: string
	clientLabel: string
	unsubscribe?: CampaignUnsubscribe
}) {
	const clientLabel = capitalizeCampaignLabel(input.clientLabel)
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: `Keep what ${input.clientLabel} just figured out`,
		preheader: 'Save one working answer as a package.',
		heading: 'Keep what you just figured out',
		body: [
			`You got ${clientLabel} to use Kody to do something. If that was useful, tell ${clientLabel} to save that work as a package so the next session does not start from zero.`,
			'One durable package is enough. You can refine it later.',
		],
		action: { label: 'Save a package', url: input.onboardingUrl },
		afterAction: [
			"And if what it did wasn't useful, then send it this:",
			{ kind: 'quote', text: "Let's talk about how we can use Kody" },
		],
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote:
			"You're receiving this because you connected an agent to Kody and have not saved a package yet.",
		unsubscribe: input.unsubscribe,
	})
}

export function buildSecondAgentEmail(input: {
	appBaseUrl: string
	portabilityUrl: string
	trialUrl?: string
	unsubscribe?: CampaignUnsubscribe
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Your home works in more than one agent',
		preheader: 'Connect a second host and keep the same memory.',
		heading: 'Bring a second agent home',
		body: [
			'You have a package. Connect a second agent so the same memory, secrets, and packages show up there too.',
		],
		action: { label: 'See how portability works', url: input.portabilityUrl },
		afterAction: input.trialUrl
			? [`A second-agent trial is available on your account: ${input.trialUrl}`]
			: undefined,
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote:
			"You're receiving this because you saved a Kody package and have connected one agent.",
		unsubscribe: input.unsubscribe,
	})
}

export function buildCoolingHomeEmail(input: {
	appBaseUrl: string
	onboardingUrl: string
	unsubscribe?: CampaignUnsubscribe
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Your home is still here',
		preheader: 'Nothing expired. Pick up when you want.',
		heading: 'Your home is still here',
		body: [
			'Kody still has your packages, memory, and secrets. Nothing expired.',
			'When you want them again, open the agent you already use and connect.',
		],
		action: { label: 'Open Kody', url: input.onboardingUrl },
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote:
			"You're receiving this because your Kody account has been quiet. This is the only poke.",
		unsubscribe: input.unsubscribe,
	})
}

export const kodyTestimonialMailto =
	'mailto:me@kentcdodds.com?subject=Kody%20testimonial'

export function buildAdvocateReferralEmail(input: {
	appBaseUrl: string
	shareUrl: string
	unsubscribe?: CampaignUnsubscribe
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Share Kody (and get a month free)',
		preheader: 'Invite a friend. Tell us what stuck.',
		heading: 'Share Kody and get a month free',
		body: [
			"You've been using Kody long enough to know if it stuck. Send someone you trust your invite. When they pay their first invoice, you both get a month of Pro.",
			"If you have thirty seconds, reply to this email and tell me what you think about Kody and how you're using it.",
			'– Kent',
		],
		action: { label: 'Open your invite link', url: input.shareUrl },
		secondaryAction: {
			label: 'Email a short testimonial',
			url: kodyTestimonialMailto,
		},
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote:
			"You're receiving this because you've been using Kody. This is the only ask.",
		unsubscribe: input.unsubscribe,
	})
}

export function buildBillingSuccessEmail(input: {
	appBaseUrl: string
	billingUrl: string
	discordUrl: string
	planLabel: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: `You're on Kody ${input.planLabel}`,
		preheader: 'Thanks for paying for the volume you actually use.',
		heading: `Welcome to ${input.planLabel}`,
		body: [
			`Your Kody account is now on the ${input.planLabel} plan. Same factory, more room for jobs, workflows, and daily volume.`,
			'Join the Discord if you want help, examples, or to talk to other people building with Kody.',
		],
		action: { label: 'Join the Kody Discord', url: input.discordUrl },
		afterAction: [`You can manage billing anytime: ${input.billingUrl}`],
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote: "You're receiving this because you subscribed to a Kody plan.",
	})
}

const creditsIllustration = {
	src: '/images/kody-lantern.png',
	alt: '',
	width: 96,
	height: 96,
}

export function buildCreditsAutoRefilledEmail(input: {
	appBaseUrl: string
	creditsUrl: string
	amountLabel: string
	balanceLabel: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: `Kody added ${input.amountLabel} in credits`,
		preheader: `Auto-refill added ${input.amountLabel}. Balance: ${input.balanceLabel}.`,
		heading: 'Credits auto-refilled',
		body: [
			`Auto-refill added ${input.amountLabel} to your Kody credits. Your balance is now ${input.balanceLabel}.`,
		],
		action: { label: 'Manage credits', url: input.creditsUrl },
		illustration: creditsIllustration,
		footnote:
			"You're receiving this because auto-refill notices are on. Turn them off on your credits page.",
	})
}

export function buildCreditsMonthlyCapEmail(input: {
	appBaseUrl: string
	creditsUrl: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Kody credits hit your monthly auto-refill cap',
		preheader: 'Auto-refill is paused until next month or a higher cap.',
		heading: 'Monthly auto-refill cap reached',
		body: [
			'Your credits are low, but another auto-refill would pass the monthly cap you set. When credits run out, usage past your monthly include stops. Add credits or raise the cap to keep going.',
		],
		action: { label: 'Manage credits', url: input.creditsUrl },
		illustration: creditsIllustration,
		footnote:
			"You're receiving this because monthly cap notices are on. Turn them off on your credits page.",
	})
}

export function buildCreditsLowBalanceEmail(input: {
	appBaseUrl: string
	creditsUrl: string
	balanceLabel: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Your Kody credits are running low',
		preheader: `Balance: ${input.balanceLabel}.`,
		heading: 'Credits running low',
		body: [
			`Your Kody credit balance is ${input.balanceLabel}. When credits run out, usage past your monthly include stops until you add more.`,
		],
		action: { label: 'Add credits', url: input.creditsUrl },
		illustration: creditsIllustration,
		footnote:
			"You're receiving this because low-balance notices are on. Turn them off on your credits page.",
	})
}

export function buildPaymentFailedEmail(input: {
	appBaseUrl: string
	billingUrl: string
}) {
	const paymentFailedCopy =
		'Stripe could not charge the card on your Kody subscription. Update your payment method so your paid limits stay in place.'
	const { afterAction } = billingFailurePromptBlocks(
		'payment_failed',
		paymentFailedCopy,
	)
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Kody could not process your payment',
		preheader: 'Update your payment method to keep your paid plan.',
		heading: 'Your payment did not go through',
		body: [paymentFailedCopy],
		action: { label: 'Update billing', url: input.billingUrl },
		afterAction,
		htmlComment: ERROR_AGENT_PROMPT_ATTR,
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote:
			"You're receiving this because a Kody subscription payment failed.",
	})
}

export function buildPastDueEmail(input: {
	appBaseUrl: string
	billingUrl: string
}) {
	const pastDueCopy =
		'Your Kody subscription is past due. Your paid limits stay in place while Stripe retries the charge, so nothing stops today — but update your payment method soon. If payment stays failed, the subscription ends and the account returns to the free plan.'
	const { afterAction } = billingFailurePromptBlocks('past_due', pastDueCopy)
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Your Kody subscription is past due',
		preheader: 'Your paid plan is waiting on a successful payment.',
		heading: 'Your subscription is past due',
		body: [pastDueCopy],
		action: { label: 'Fix billing', url: input.billingUrl },
		afterAction,
		htmlComment: ERROR_AGENT_PROMPT_ATTR,
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote:
			"You're receiving this because your Kody subscription is past due.",
	})
}

export type UserErrorRateEmailRun = {
	/** Package name, or the run's display name when it has no package. */
	label: string
	error: string
	runUrl: string
}

export type PackageOwnerErrorSpikeEmailPackage = {
	kodyId: string
	errors: number
	events: number
	rate: number | null
}

export type PackageOwnerErrorSpikeEmailMetric = {
	metric: string
	errors: number
	events: number
}

export function buildPackageOwnerErrorSpikeEmail(input: {
	appBaseUrl: string
	activityUrl: string
	jobsUrl: string
	supportUrl: string
	ownerLabel: string
	errorCount: number
	eventCount: number
	rate: number | null
	spikeStartedAt: string
	packages: Array<PackageOwnerErrorSpikeEmailPackage>
	byMetric: Array<PackageOwnerErrorSpikeEmailMetric>
}) {
	const percent =
		input.rate != null
			? Math.round(input.rate * 100)
			: input.eventCount > 0
				? Math.round((input.errorCount / input.eventCount) * 100)
				: 0
	const packageLines =
		input.packages.length > 0
			? input.packages.map((pkg) => {
					const pkgPercent =
						pkg.rate != null
							? Math.round(pkg.rate * 100)
							: pkg.events > 0
								? Math.round((pkg.errors / pkg.events) * 100)
								: 0
					return `${pkg.kodyId}: ${pkg.errors.toLocaleString('en-US')} errors / ${pkg.events.toLocaleString('en-US')} runs (${pkgPercent}%)`
				})
			: []
	const metricLines =
		input.byMetric.length > 0
			? input.byMetric.map(
					(row) =>
						`${row.metric}: ${row.errors.toLocaleString('en-US')} errors across ${row.events.toLocaleString('en-US')} events`,
				)
			: []
	const started = formatSpikeStarted(input.spikeStartedAt)
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Your Kody packages are erroring heavily right now',
		preheader: `${input.errorCount.toLocaleString('en-US')} errors in the last hour (${percent}%).`,
		heading: 'Package error spike',
		body: [
			`In the last hour, packages owned by ${input.ownerLabel} recorded ${input.errorCount.toLocaleString('en-US')} errors across ${input.eventCount.toLocaleString('en-US')} runs (${percent}%).`,
			`This episode started around ${started}.`,
			...(packageLines.length > 0
				? ['Packages contributing the most errors:', ...packageLines]
				: []),
			...(metricLines.length > 0
				? ['Error volume by kind:', ...metricLines]
				: []),
			'Fix the failing code, disable a broken job or trigger, or pause the package until it is healthy. Review recent runs and job history from the links below.',
		],
		action: { label: 'Review activity', url: input.activityUrl },
		secondaryAction: { label: 'Manage jobs and triggers', url: input.jobsUrl },
		afterAction: [
			'Disable a broken job or trigger from Jobs if the failure is looping.',
			`Support: ${input.supportUrl}`,
		],
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote:
			"You're receiving this because a package you publish crossed an hourly error-spike threshold. You will not get another email for this episode until it recovers.",
	})
}

function formatSpikeStarted(iso: string) {
	const ms = Date.parse(iso)
	if (!Number.isFinite(ms)) return iso
	return new Date(ms)
		.toISOString()
		.replace('T', ' ')
		.replace(/\.\d{3}Z$/, ' UTC')
}

export function buildUserErrorRateEmail(input: {
	appBaseUrl: string
	activityUrl: string
	supportUrl: string
	errorCount: number
	eventCount: number
	failingRuns?: Array<UserErrorRateEmailRun>
}) {
	const percent =
		input.eventCount > 0
			? Math.round((input.errorCount / input.eventCount) * 100)
			: 0
	const failingRuns = input.failingRuns ?? []
	const firstLabel = failingRuns[0]?.label
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Your Kody runs are erroring more than usual',
		preheader: firstLabel
			? `${firstLabel} is among the failures. Here is what went wrong.`
			: 'A look at the failures, and where to get help.',
		heading: 'A few runs need attention',
		body: [
			`This month Kody recorded ${input.errorCount.toLocaleString('en-US')} errors across ${input.eventCount.toLocaleString('en-US')} runs (${percent}%).`,
			...(failingRuns.length > 0
				? [
						failingRuns.length === 1
							? 'The most recent open failure:'
							: 'The most recent open failures:',
						...failingRuns.map((run) => ({
							text: `${run.label} failed: ${run.error}`,
							link: { label: 'Open the run', url: run.runUrl },
						})),
					]
				: []),
			'Review the activity log, or contact support if you need help sorting out the failures.',
		],
		action: { label: 'Review account activity', url: input.activityUrl },
		afterAction: [`Support: ${input.supportUrl}`],
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote:
			"You're receiving this because your Kody account crossed an error-rate threshold.",
	})
}

export function buildPlatformFeedbackAcknowledgementEmail(input: {
	appBaseUrl: string
	feedbackId: string
}) {
	const feedbackId = input.feedbackId.trim()
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'We got your Kody feedback',
		preheader: 'Thanks — we have your note and will take a look.',
		heading: 'We got your feedback',
		body: [
			'Thanks for telling us. We received your note and will take a look.',
			`Your feedback id is ${feedbackId}.`,
			'Your agent can check status anytime with metaPlatformFeedbackGet.',
		],
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote: "You're receiving this because you sent Kody platform feedback.",
	})
}

export function buildPlatformFeedbackOutcomeEmail(input: {
	appBaseUrl: string
	status: PlatformFeedbackOutcomeStatus
	summary: string
	userMessage?: string
}) {
	const copy = platformFeedbackOutcomeCopy(input.status)
	const userMessage = input.userMessage?.trim()
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: copy.subject,
		preheader: copy.preheader,
		heading: 'Thanks for your feedback',
		body: [
			copy.decision(input.summary.trim()),
			...(userMessage ? [userMessage] : []),
			'Thanks for taking the time to tell us. Notes like yours help us make Kody better.',
			'If you have more to share, tell your agent you want to send more Kody feedback.',
		],
		illustration: {
			src: '/images/kody-lantern.png',
			alt: '',
			width: 96,
			height: 96,
		},
		footnote: "You're receiving this because you sent Kody platform feedback.",
	})
}

function platformFeedbackOutcomeCopy(status: PlatformFeedbackOutcomeStatus) {
	switch (status) {
		case 'resolved':
			return {
				subject: 'We resolved your Kody feedback',
				preheader: 'Thanks for telling us — here is what happened.',
				decision: (summary: string) =>
					`We resolved your feedback about "${summary}".`,
			}
		case 'dismissed':
			return {
				subject: 'An update on your Kody feedback',
				preheader: 'Thanks for telling us — here is what happened.',
				decision: (summary: string) =>
					`We reviewed your feedback about "${summary}" and closed it without a product change this time.`,
			}
		default: {
			const exhaustive: never = status
			throw new Error(
				`Unknown platform feedback outcome status: ${String(exhaustive)}`,
			)
		}
	}
}

export function buildPasswordResetEmail(input: {
	appBaseUrl: string
	resetUrl: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Reset your Kody password',
		preheader: 'Use this link to choose a new password.',
		heading: 'Reset your password',
		body: [
			'We received a request to reset the password on your Kody account.',
			'Use the link below to choose a new one.',
		],
		action: { label: 'Reset password', url: input.resetUrl },
		afterAction: ['This link expires in 1 hour and can only be used once.'],
		footnote:
			'If you did not request a reset, you can safely ignore this email — your password stays unchanged.',
	})
}

export function buildPasswordResetConfirmedEmail(input: {
	appBaseUrl: string
	accountUrl: string
}) {
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: 'Your Kody password was reset',
		preheader: 'Your password changed. Extra sign-in methods were removed.',
		heading: 'Your password was reset',
		body: [
			'Your Kody password was changed using a reset link.',
			'Two-factor authentication, passkeys, and linked sign-in providers were removed; set them up again from your account.',
		],
		action: { label: 'Open account settings', url: input.accountUrl },
		footnote:
			'If you did not reset your password, sign in and change it again, then review your account security.',
	})
}
