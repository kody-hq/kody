/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { SiteLink } from '../components/site-link.tsx'
import { revealRef } from '../components/reveal.ts'
import { useShellData } from '../routes/__root.tsx'
import {
	creditsUnlockMultiplier,
	formatDurableObjectRowsRead,
	formatMinJobInterval,
	weeklyComputeWindowNote,
	type PlanLimits,
} from '#universal/plans.ts'
import {
	pricingLimitColumns,
	type PricingLimitColumn,
} from '#universal/pricing-limits.ts'
import {
	publicSignupPrimaryCta,
	type PublicSignupCta,
} from '#universal/public-signup-copy.ts'
import { docHref } from '#universal/docs-nav.ts'
import { orgBillingPath } from '#universal/org-pages.ts'
import { colors, radius, typography } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	getSurfaceCardCss,
	layoutMaxWidths,
	pageHeadCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'

/**
 * Pricing page, ported from the redesign prototype (`landing/pricing.html`).
 * Two flat plan panels (Free and Pro) over a 44rem spec-sheet measure; Pro's
 * green border is the only loud element. Limits render as one honest table grouped under
 * display-face section titles - every value comes from `plans.ts`, never
 * hardcoded here.
 */

type LimitValue = {
	text: string
	muted?: boolean
}

type LimitRow = {
	label: string
	key: keyof PlanLimits
	format?: (value: number) => LimitValue
	/** Monthly meter that keeps running past the include, debiting credits. */
	chargedPastInclude?: true
}

type LimitGroup = {
	title: string
	note?: string
	rows: ReadonlyArray<LimitRow>
}

const count = new Intl.NumberFormat('en-US')
const size = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const factoryGuideHref = docHref('kody-factory')

const limitGroups: ReadonlyArray<LimitGroup> = [
	{
		title: 'Packages & jobs',
		rows: [
			{ label: 'Connected repos', key: 'maxRepos' },
			{ label: 'Saved packages', key: 'maxSavedPackages' },
			{ label: 'Scheduled jobs', key: 'maxScheduledJobs' },
			{
				label: 'Fastest job interval',
				key: 'minJobIntervalMs',
				format: (value) => ({ text: formatMinJobInterval(value) }),
			},
			{ label: 'Active repo sessions', key: 'maxRepoSessions' },
		],
	},
	{
		title: 'Compute',
		note: weeklyComputeWindowNote,
		rows: [
			{ label: 'Concurrent workflows', key: 'maxConcurrentWorkflows' },
			{
				label: 'Unique execute workers per day',
				key: 'maxExecuteUniqueWorkersPerDay',
			},
			{
				label: 'Unique execute workers per week',
				key: 'maxExecuteUniqueWorkersPerWeek',
			},
			{ label: 'Outbound fetches per day', key: 'maxOutboundFetchesPerDay' },
			{ label: 'Outbound fetches per week', key: 'maxOutboundFetchesPerWeek' },
			{ label: 'Job runs per day', key: 'maxJobRunsPerDay' },
			{
				label: 'Automation invocations per day',
				key: 'maxAutomationInvocationsPerDay',
			},
			{
				label: 'Worker compute per month',
				key: 'maxUniqueWorkerDaysPerMonth',
				chargedPastInclude: true,
			},
			{
				label: 'Durable Object rows read per month',
				key: 'maxDurableObjectRowsReadPerMonth',
				format: (value) => ({ text: formatDurableObjectRowsRead(value) }),
				chargedPastInclude: true,
			},
		],
	},
	{
		title: 'Email',
		rows: [
			{ label: 'Sends per day', key: 'maxEmailSendsPerDay' },
			{ label: 'Receives per day', key: 'maxEmailReceivesPerDay' },
			{ label: 'Stored messages', key: 'maxStoredEmailMessages' },
			{
				label: 'Maximum message size',
				key: 'maxEmailMessageBytes',
				format: (value) => ({ text: formatLimitBytes(value) }),
			},
		],
	},
	{
		title: 'Storage & secrets',
		rows: [
			{ label: 'Stored secrets', key: 'maxSecrets' },
			{
				label: 'Durable storage',
				key: 'maxStorageBytes',
				format: (value) => ({ text: formatLimitBytes(value) }),
			},
		],
	},
]

export function PricingPage({
	isSignedIn,
	showImprovedSearch,
}: {
	isSignedIn: boolean
	showImprovedSearch: boolean
}) {
	const { session } = useShellData()
	const signedOutCta = publicSignupPrimaryCta()
	const improvedSearchNote = showImprovedSearch
		? ' Improved search when the candidate pool is ambiguous.'
		: ''
	return (
		<section css={pricingCss}>
			<header css={pageHeadCss}>
				<h1 data-rise css={{ '--rise': '0' }}>
					Start free.
					<br />
					Pay when Kody <em>earns it</em>.
				</h1>
				<p>
					Your agents' cloud is a factory: it turns the work they do once into
					durable software that keeps running. Every plan is the whole factory.
					You pay for volume.
				</p>
			</header>

			<div css={plansCss}>
				<section
					aria-labelledby="plan-free"
					css={planPanelCss}
					ref={revealRef()}
				>
					<h2 id="plan-free" css={planTitleCss}>
						Free
					</h2>
					<p css={planPriceCss}>$0</p>
					<p css={planCopyCss}>
						The whole {factoryGuideLink()}. 5 jobs, no faster than every 15
						minutes.
					</p>
					{isSignedIn ? (
						<SiteLink href="/account" css={planPillButtonCss}>
							Open your account
						</SiteLink>
					) : (
						<SiteLink href={signedOutCta.href} css={planPillButtonCss}>
							{signedOutCta.label}
						</SiteLink>
					)}
				</section>

				<section
					aria-labelledby="plan-pro"
					css={featuredPlanPanelCss}
					ref={revealRef(90)}
				>
					<h2 id="plan-pro" css={planTitleCss}>
						Pro
					</h2>
					<p css={featuredPlanPriceCss}>
						$12<small css={planPriceUnitCss}>/month</small>
					</p>
					<p css={planPriceNoteCss}>or $120/year</p>
					<p css={planCopyCss}>
						Same {factoryGuideLink()}. More room for jobs, workflows, and daily
						volume, with a monthly include. Need more? Add prepaid credits.
						{improvedSearchNote}
					</p>
					{renderPaidPlanCta(
						isSignedIn,
						signedOutCta,
						personalBillingHref(session),
					)}
				</section>

				{/*
				 * Contact strip, not a third SKU. No price, no extra
				 * column, no feature-matrix cells - Teams/Enterprise stays
				 * manual.
				 */}
				<section
					aria-labelledby="plan-teams"
					css={teamsInviteCss}
					ref={revealRef(180)}
				>
					<div>
						<h2 id="plan-teams" css={planTitleCss}>
							Teams / Enterprise
						</h2>
						<p css={teamsInviteCopyCss}>
							Running Kody across a team or with higher needs? Email us -
							we&rsquo;re shaping that offering and want to hear your needs.
						</p>
					</div>
					<SiteLink href="mailto:kody@kody.codes" css={teamsInviteButtonCss}>
						Email us
					</SiteLink>
				</section>
			</div>

			<section aria-labelledby="limits-title" css={limitsCss}>
				<h2 id="limits-title" css={limitsTitleCss}>
					Here&rsquo;s what you get
				</h2>
				<div css={limitsScrollCss}>
					<table css={limitsTableCss}>
						<thead>
							<tr>
								<th scope="col">
									<span css={visuallyHiddenCss}>Resource</span>
								</th>
								{pricingLimitColumns.map((column) => (
									<th scope="col" key={column.id}>
										<span data-limits-plan>{column.plan}</span>
										<span data-limits-price>{column.price}</span>
										{column.priceNote ? (
											<span data-limits-annual>{column.priceNote}</span>
										) : null}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{limitGroups.flatMap((group) => [
								<tr key={group.title} data-group>
									<th colSpan={pricingLimitColumns.length + 1}>
										{group.title}
									</th>
								</tr>,
								...group.rows.map((row) => (
									<tr key={row.key}>
										<th scope="row">{row.label}</th>
										{pricingLimitColumns.map((column) =>
											renderLimitCell(row, column),
										)}
									</tr>
								)),
								...(group.note
									? [
											<tr key={`${group.title}-note`} data-note>
												<td colSpan={pricingLimitColumns.length + 1}>
													{group.note}
												</td>
											</tr>,
										]
									: []),
							])}
						</tbody>
					</table>
				</div>
				<h3 id="credits-title" css={creditsTitleCss}>
					Prepaid credits
				</h3>
				<p css={limitsFootnoteCss} data-credits-story>
					Pro includes the usage in the table. Need more? Add prepaid credits
					and keep going until they run out. Free stops at its execute caps and
					other hard limits (fetches, job runs, email, and storage). On Free,
					monthly Worker compute and Rows read are guidelines: they never charge
					you or stop runs.
				</p>
				<p css={limitsFootnoteCss} data-credits-small-print>
					Usage past the include is charged from credits (Worker compute and
					Rows read). On credits, daily and weekly limits go up to{' '}
					{creditsUnlockMultiplier}× Pro&rsquo;s include, capped at the
					&ldquo;Pro + credits&rdquo; column. When credits run out, usage past
					the include stops. No overage invoices.
				</p>
				<p css={limitsFootnoteCss} data-credits-seats>
					In an organization, daily and weekly limits are one shared pool for
					everyone. Each paid seat adds the Pro unique execute workers, outbound
					fetches, job runs, and automation invocations (and their &ldquo;Pro +
					credits&rdquo; caps) to the pool, and raises the execute runaway brake
					(300 calls per minute per seat). Credits come from one organization
					wallet.
				</p>
				<p css={limitsFootnoteCss}>
					Unique execute workers and outbound fetches count per day and per
					week; whichever window fills first applies. Durable Object duration is
					unmetered.
				</p>
			</section>

			<p css={limitsCtaCss}>
				{isSignedIn ? (
					<SiteLink href="/account" css={limitsCtaButtonCss}>
						Open your account
					</SiteLink>
				) : (
					<SiteLink href={signedOutCta.href} css={limitsCtaButtonCss}>
						{signedOutCta.label}
					</SiteLink>
				)}
			</p>
		</section>
	)
}

function factoryGuideLink() {
	return <SiteLink href={factoryGuideHref}>factory</SiteLink>
}

function personalBillingHref(
	session: {
		organizations?: ReadonlyArray<{ slug: string; personal: boolean }>
	} | null,
) {
	const slug = session?.organizations?.find((org) => org.personal)?.slug
	return slug ? orgBillingPath(slug) : '/account'
}

function renderPaidPlanCta(
	isSignedIn: boolean,
	signedOutCta: PublicSignupCta,
	signedInBillingHref: string,
) {
	if (isSignedIn) {
		return (
			<SiteLink href={signedInBillingHref} css={planGhostButtonCss}>
				Upgrade in billing
			</SiteLink>
		)
	}
	return (
		<SiteLink href={signedOutCta.href} css={planGhostButtonCss}>
			{signedOutCta.label}
		</SiteLink>
	)
}

function renderLimitCell(row: LimitRow, column: PricingLimitColumn) {
	const value = column.limits[row.key]
	if (value == null) {
		return <td>-</td>
	}
	const formatted = row.format
		? row.format(value)
		: { text: count.format(value) }
	const isGuideline = row.chargedPastInclude && column.monthlyIncludeIsGuideline
	const cell = isGuideline
		? { text: `${formatted.text} guideline`, muted: true }
		: formatted
	const text =
		row.chargedPastInclude && column.chargesPastInclude
			? `${cell.text} + credits`
			: cell.text
	return (
		<td>
			{cell.muted ? (
				<span css={{ color: colors.textMuted }}>{text}</span>
			) : (
				text
			)}
		</td>
	)
}

function formatLimitBytes(value: number): string {
	const kibibyte = 1024
	const mebibyte = 1024 * kibibyte
	const gibibyte = 1024 * mebibyte
	// Bounded fraction digits: a limit that is not a clean power of two would
	// otherwise render with `Intl`'s default three decimals (750000 bytes as
	// "732.422 KiB"), which reads like precision the table does not mean.
	if (value >= gibibyte) return `${size.format(value / gibibyte)}\u00A0GiB`
	if (value >= mebibyte) return `${size.format(value / mebibyte)}\u00A0MiB`
	return `${size.format(value / kibibyte)}\u00A0KiB`
}

const pricingCss: CSSObject = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding:
		'clamp(3rem, 7vw, 5.5rem) clamp(1.25rem, 4vw, 2.5rem) clamp(4rem, 8vw, 6.5rem)',
}

/* The prototype's two-up measure; one column once the cards would squeeze. */
const plansCss: CSSObject = {
	width: 'min(100%, 44rem)',
	margin: 'clamp(2.5rem, 6vw, 4rem) auto 0',
	display: 'grid',
	gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
	gap: '1.2rem',
	'@media (max-width: 680px)': {
		gridTemplateColumns: '1fr',
	},
}

const planPanelCss: CSSObject = {
	...getSurfaceCardCss(),
	display: 'flex',
	flexDirection: 'column' as const,
	alignItems: 'flex-start',
	gap: '1rem',
	textAlign: 'left' as const,
	/* Prototype `.plan` sits one step above the base card radius. */
	borderRadius: `calc(${radius.card} + 4px)`,
	padding: 'clamp(1.5rem, 3vw, 2rem)',
	'@media (max-width: 680px)': {
		alignItems: 'stretch',
		textAlign: 'center' as const,
	},
}

/*
 * The featured plan carries the accent; the border is the only loud thing on
 * the page.
 */
const featuredPlanPanelCss: CSSObject = {
	...planPanelCss,
	borderColor: `oklch(from ${colors.primary} l c h / 0.6)`,
}

const planTitleCss: CSSObject = {
	margin: 0,
	fontSize: '1.15rem',
	fontWeight: 720,
	letterSpacing: '-0.012em',
}

const planPriceCss: CSSObject = {
	margin: 0,
	fontFamily: typography.fontFamilyDisplay,
	fontWeight: 760,
	fontSize: 'clamp(2.1rem, 4vw, 2.6rem)',
	lineHeight: 1,
	letterSpacing: '-0.025em',
}

const featuredPlanPriceCss: CSSObject = {
	...planPriceCss,
	color: colors.primaryText,
}

const planPriceUnitCss: CSSObject = {
	font: `550 1rem/1 ${typography.fontFamilyBody}`,
	color: colors.textMuted,
	letterSpacing: 0,
	marginLeft: '0.2rem',
}

const planPriceNoteCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.92rem',
}

const planCopyCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.98rem',
	maxWidth: '34ch',
	textWrap: 'pretty' as const,
	'& a': {
		color: colors.primaryText,
		textDecoration: 'underline',
		textUnderlineOffset: '0.15em',
	},
	'@media (max-width: 680px)': {
		marginInline: 'auto',
	},
}

const planButtonSizeCss: CSSObject = {
	marginTop: 'auto',
	fontSize: '0.95rem',
	padding: '0.8rem 1.35rem',
	maxWidth: '100%',
	boxSizing: 'border-box' as const,
	'@media (max-width: 680px)': {
		marginTop: '0.4rem',
	},
}

const planPillButtonCss: CSSObject = {
	...getPillButtonCss(),
	...planButtonSizeCss,
}

const planGhostButtonCss: CSSObject = {
	...getGhostButtonCss(),
	...planButtonSizeCss,
}

const teamsInviteCss: CSSObject = {
	...getSurfaceCardCss(),
	gridColumn: '1 / -1',
	display: 'flex',
	flexDirection: 'row' as const,
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: '1.2rem',
	textAlign: 'left' as const,
	borderRadius: `calc(${radius.card} + 4px)`,
	padding: 'clamp(1.5rem, 3vw, 2rem)',
	'@media (max-width: 680px)': {
		flexDirection: 'column' as const,
		alignItems: 'stretch',
		textAlign: 'center' as const,
	},
}

const teamsInviteCopyCss: CSSObject = {
	...planCopyCss,
	marginTop: '0.55rem',
	maxWidth: '62ch',
}

const teamsInviteButtonCss: CSSObject = {
	...getGhostButtonCss(),
	...planButtonSizeCss,
	marginTop: 0,
	flexShrink: 0,
	'@media (max-width: 680px)': {
		marginTop: '0.4rem',
	},
}

/* One honest table, no marketing checkmarks. Spec-sheet measure - narrow
   enough that the eye never loses the row between label and value. */
const limitsCss: CSSObject = {
	width: 'min(100%, 44rem)',
	margin: 'clamp(3.5rem, 8vw, 5.5rem) auto 0',
}

const limitsTitleCss: CSSObject = {
	margin: 0,
	fontSize: 'clamp(1.5rem, 2.6vw, 1.9rem)',
	fontWeight: 720,
	letterSpacing: '-0.018em',
	textAlign: 'center' as const,
}

const limitsScrollCss: CSSObject = {
	marginTop: '1.8rem',
	overflowX: 'auto' as const,
}

const limitsCtaCss: CSSObject = {
	margin: '2.4rem 0 0',
	textAlign: 'center' as const,
}

const limitsFootnoteCss: CSSObject = {
	margin: '1rem 0 0',
	color: colors.textMuted,
	font: `450 0.88rem/1.45 ${typography.fontFamilyBody}`,
}

const creditsTitleCss: CSSObject = {
	margin: '1.8rem 0 0',
	font: `700 1.05rem/1.2 ${typography.fontFamilyDisplay}`,
	letterSpacing: '-0.01em',
	color: colors.text,
}

const limitsCtaButtonCss = getPillButtonCss()

const limitsTableCss: CSSObject = {
	width: '100%',
	borderCollapse: 'collapse' as const,
	fontSize: '0.98rem',
	'& th, & td': {
		padding: '0.7rem 0.9rem',
		borderBottom: `1px solid ${colors.border}`,
	},
	/* Labels and values sit flush with the hairline edges; the plan columns
	   share one width so the tiers compare down a steady axis. */
	'& th:first-child, & td:first-child': {
		paddingLeft: '0.2rem',
	},
	'& th:last-child, & td:last-child': {
		paddingRight: '0.2rem',
	},
	'& thead th:not(:first-child), & td': {
		width: '7.5rem',
	},
	'& thead th': {
		font: `600 0.82rem/1.2 ${typography.fontFamilyBody}`,
		letterSpacing: '0.07em',
		textTransform: 'uppercase' as const,
		color: colors.textMuted,
		textAlign: 'left' as const,
		verticalAlign: 'bottom',
		borderBottomColor: colors.textMuted,
	},
	/* Plan header carries its price, so the table answers "which $?" alone. */
	'& [data-limits-plan]': {
		display: 'block',
		color: colors.text,
	},
	/* Pro columns are the featured plan - the accent follows its panel. */
	'& thead th:nth-child(n + 3) [data-limits-plan]': {
		color: colors.primaryText,
	},
	'& [data-limits-price]': {
		display: 'block',
		marginTop: '0.1rem',
		font: `500 0.8rem/1.2 ${typography.fontFamilyBody}`,
		letterSpacing: 0,
		textTransform: 'none' as const,
		color: colors.textMuted,
	},
	'& [data-limits-annual]': {
		display: 'block',
		marginTop: '0.15rem',
		font: `500 0.72rem/1.25 ${typography.fontFamilyBody}`,
		letterSpacing: 0,
		textTransform: 'none' as const,
		color: colors.textMuted,
		whiteSpace: 'normal' as const,
	},
	/* Group titles are the table's spine: display face, extra air above. */
	'& tr[data-group] th': {
		padding: '2rem 0.2rem 0.55rem',
		font: `700 1.05rem/1.2 ${typography.fontFamilyDisplay}`,
		letterSpacing: '-0.01em',
		textTransform: 'none' as const,
		color: colors.text,
	},
	'& tbody tr:first-child th': {
		paddingTop: '1.1rem',
	},
	'& tbody th': {
		fontWeight: 450,
		color: colors.text,
		textAlign: 'left' as const,
	},
	'& tr[data-note] td': {
		padding: '0.45rem 0.2rem 0.85rem',
		color: colors.textMuted,
		fontSize: '0.88rem',
		whiteSpace: 'normal' as const,
		borderBottom: `1px solid ${colors.border}`,
	},
	'& td': {
		textAlign: 'left' as const,
		whiteSpace: 'nowrap' as const,
		fontVariantNumeric: 'tabular-nums',
		color: colors.text,
	},
}
