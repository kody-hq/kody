/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { SiteLink } from '../components/site-link.tsx'
import { formatTimestamp } from '../components/local-timestamp.tsx'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	MetadataGrid,
} from './account-management-components.tsx'
import { RecordTable } from './record-table.tsx'
import { formatEstimatedCreditMicroUsd } from '#universal/credits.ts'
import {
	type OrgCreditsBudget,
	type OrgCreditsLedgerEntry,
	type OrgCreditsLoaderData,
} from '#universal/loader-data.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	getGhostButtonCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import { loadCreditsPage } from '#start/server/org-credits'

/**
 * Ledger money keeps every nonzero micro-USD: a rows-read debit can be a
 * single micro-USD, which the three-decimal rate-card format shows as $0.00.
 */
export function formatLedgerMicroUsd(microUsd: number) {
	if (!Number.isFinite(microUsd) || microUsd === 0) return '$0.00'
	const sign = microUsd < 0 ? '−' : ''
	const abs = Math.abs(microUsd)
	const formatted = (abs / 1_000_000).toLocaleString('en-US', {
		minimumFractionDigits: 2,
		maximumFractionDigits: abs % 1_000 === 0 ? 3 : 6,
	})
	return `${sign}$${formatted}`
}

/** Signed ledger amount: usage debits are often well under a cent. */
export function formatLedgerAmount(microUsd: number) {
	const formatted = formatLedgerMicroUsd(microUsd)
	return microUsd > 0 ? `+${formatted}` : formatted
}

export function formatBudgetLine(budget: OrgCreditsBudget) {
	const limit = formatEstimatedCreditMicroUsd(budget.budgetMicroUsd)
	return budget.spentMicroUsd === null
		? `${limit} per month (spend unavailable right now)`
		: `${formatEstimatedCreditMicroUsd(budget.spentMicroUsd)} of ${limit} spent this month`
}

function yourBudgetValue(data: OrgCreditsLoaderData) {
	const yours = data.budgets.yours
	if (!yours) return 'No monthly budget applies to you.'
	const source =
		yours.source === 'individual' ? 'set for you' : 'the organization default'
	return `${formatBudgetLine(yours)} (${source})`
}

function renderBudgets(data: OrgCreditsLoaderData) {
	const orgBudgets = data.budgets.org
	const items = [{ label: 'Your monthly budget', value: yourBudgetValue(data) }]
	if (orgBudgets) {
		items.push(
			{
				label: 'Default per-person budget',
				value:
					orgBudgets.defaultUserBudgetMicroUsd === null
						? 'None'
						: `${formatEstimatedCreditMicroUsd(orgBudgets.defaultUserBudgetMicroUsd)} per month`,
			},
			{
				label: 'Automation budget',
				value: orgBudgets.automation
					? formatBudgetLine(orgBudgets.automation)
					: 'None',
			},
		)
	}
	return (
		<AccountManagementPanel
			title="Budgets"
			description={`Monthly caps on credits spent past the include. Spend resets each UTC month (now ${data.budgets.month}).`}
		>
			<MetadataGrid items={items} />
		</AccountManagementPanel>
	)
}

function renderBalance(wallet: NonNullable<OrgCreditsLoaderData['wallet']>) {
	return (
		<AccountManagementPanel
			title="Balance"
			description={
				wallet.creditsEligible
					? 'Usage past the monthly include is charged here until it runs out.'
					: 'Credits pay for usage past the Pro monthly include. This organization is not on Pro, so the balance is kept until it is.'
			}
		>
			<p
				data-org-credits-balance
				css={css({
					margin: 0,
					fontSize: 'clamp(2rem, 4vw, 2.6rem)',
					fontWeight: 760,
					letterSpacing: '-0.02em',
					fontVariantNumeric: 'tabular-nums',
					color: wallet.balanceMicroUsd < 0 ? colors.error : colors.text,
				})}
			>
				{formatLedgerMicroUsd(wallet.balanceMicroUsd)}
			</p>
			<p css={css(descriptionCss)}>
				Auto-refill is {wallet.autoRefillEnabled ? 'on' : 'off'}.{' '}
				<SiteLink href={wallet.manageHref} css={css(primaryLinkCss)}>
					Add credits or change auto-refill
				</SiteLink>
			</p>
		</AccountManagementPanel>
	)
}

function renderLedgerTable(entries: Array<OrgCreditsLedgerEntry>) {
	return (
		<RecordTable
			mode="none"
			ariaLabel="Credit ledger"
			scrollHeight="none"
			columns={[
				{ key: 'description', label: 'Entry', primary: true },
				{ key: 'type', label: 'Type', drop: 1 },
				{ key: 'date', label: 'Date', drop: 3 },
				{ key: 'amount', label: 'Amount', align: 'end' },
				{ key: 'balance', label: 'Balance after', align: 'end' },
			]}
			rows={entries.map((entry) => ({
				id: entry.id,
				cells: {
					description: (
						<span data-credits-ledger-kind={entry.kind}>
							{entry.description}
							{entry.detail ? (
								<span
									css={css({
										display: 'block',
										color: colors.textMuted,
										fontSize: '0.85em',
									})}
								>
									{entry.detail}
								</span>
							) : null}
						</span>
					),
					type: entry.typeLabel,
					date: formatTimestamp(entry.createdAt),
					amount: (
						<span
							css={css({
								color:
									entry.amountMicroUsd > 0 ? colors.primaryText : colors.text,
							})}
						>
							{formatLedgerAmount(entry.amountMicroUsd)}
						</span>
					),
					balance: formatLedgerMicroUsd(entry.balanceAfterMicroUsd),
				},
			}))}
		/>
	)
}

export function OrgCreditsPage({
	payload,
	currentHref,
	actorKey,
	orgSlug,
}: {
	payload: OrgCreditsLoaderData
	currentHref: string
	actorKey: string
	orgSlug: string
}) {
	const ledger = useInfiniteQuery({
		queryKey: [
			'orgCreditsLedger',
			actorKey,
			orgSlug,
			payload.ledger?.nextCursor ?? null,
		],
		initialPageParam: payload.ledger?.nextCursor ?? null,
		queryFn: async ({ pageParam, signal }) =>
			(await loadCreditsPage({ data: { orgSlug, cursor: pageParam }, signal }))
				.payload,
		getNextPageParam: (page) => page.ledger?.nextCursor ?? undefined,
		staleTime: 10_000,
		enabled: false,
	})
	const entries = [
		...(payload.ledger?.entries ?? []),
		...(ledger.data?.pages.flatMap((page) => page.ledger?.entries ?? []) ?? []),
	]
	const hasOlder = ledger.data
		? ledger.hasNextPage
		: Boolean(payload.ledger?.nextCursor)
	return (
		<AccountManagementShell currentHref={currentHref}>
			<AccountPageHeader
				entity="credits"
				title="Credits"
				description="Credit balance, budgets, and every credit added or spent."
				currentHref={currentHref}
			/>
			{payload.wallet ? renderBalance(payload.wallet) : null}
			{renderBudgets(payload)}
			{payload.access === 'member' ? (
				<p css={descriptionCss} data-org-credits-member-note>
					Owners and billing admins see the balance and ledger.
				</p>
			) : null}
			{payload.ledger && payload.wallet ? (
				<AccountManagementPanel
					title="Ledger"
					description="Every change to the balance, newest first: purchases, auto-refills, grants, and usage charges."
				>
					{entries.length === 0 ? (
						<p css={descriptionCss}>No credit activity yet.</p>
					) : (
						renderLedgerTable(entries)
					)}
					{ledger.error ? (
						<AccountManagementMessage tone="error">
							{ledger.error.message}
						</AccountManagementMessage>
					) : null}
					<div
						css={{
							display: 'flex',
							flexWrap: 'wrap',
							gap: spacing.md,
							alignItems: 'center',
						}}
					>
						{hasOlder ? (
							<button
								type="button"
								disabled={ledger.isFetchingNextPage}
								data-org-credits-load-older
								css={getGhostButtonCss({ size: 'sm' })}
								onClick={() => void ledger.fetchNextPage()}
							>
								{ledger.isFetchingNextPage ? 'Loading…' : 'Load older'}
							</button>
						) : null}
						<SiteLink
							href={payload.wallet.whereItWentHref}
							css={primaryLinkCss}
						>
							See which packages used credits this month
						</SiteLink>
					</div>
				</AccountManagementPanel>
			) : null}
		</AccountManagementShell>
	)
}
