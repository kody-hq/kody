/** @jsxImportSource @emotion/react */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import {
	adminCreditWalletQuery,
	adminCreditGrantOptions,
} from '../admin-user-credits-query.ts'
import { usePageInvalidation } from '../page-invalidation.ts'
import { useState, type FormEvent } from 'react'
import { formatTimestampDate } from '../components/local-timestamp.tsx'
import {
	formatSignedMicroUsd,
	parseDollarsToCents,
} from '#client/routes/credit-amount-input.ts'
import {
	creditAdminGrantNoteMaxLength,
	formatCents,
	formatMicroUsd,
	signupWelcomeCreditLedgerIdPrefix,
	validateCreditAdminGrantCents,
} from '#universal/credits.ts'
import { type AccountCreditsLedgerItem } from '#universal/loader-data.ts'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getAuthInputCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	MetadataGrid,
} from './account-management-components.tsx'
const ledgerKindLabels: Record<AccountCreditsLedgerItem['kind'], string> = {
	top_up: 'Top-up',
	auto_refill: 'Auto-refill',
	admin_grant: 'Admin grant',
	debit: 'Debit',
}
type CreditsStatus = 'loading' | 'ready' | 'error'
/**
 * Credit wallet for the selected account: balance, eligibility, a grant
 * form, and the recent ledger. Keyed by `stableUserId` so switching users
 * starts from a fresh load.
 */
export function AdminUserCreditsPanel(props: {
	stableUserId: string
	onGranted?: () => void
}) {
	const invalidatePages = usePageInvalidation(mutationResources)
	const { actorKey } = useRouteContext({ from: '__root__' })
	const client = useQueryClient()
	const walletQuery = useQuery(
		adminCreditWalletQuery(actorKey, props.stableUserId),
	)
	const wallet = walletQuery.data
	const status: CreditsStatus = walletQuery.isPending
		? 'loading'
		: walletQuery.isError
			? 'error'
			: 'ready'
	const grant = useMutation(adminCreditGrantOptions(client, invalidatePages))

	const [amountText, setAmountText] = useState('')
	const [noteText, setNoteText] = useState('')
	const granting = grant.isPending
	const [message, setMessage] = useState<string | null>(null)
	const [messageTone, setMessageTone] = useState<'info' | 'error'>('info')
	async function submitGrant(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (granting) return
		const amount = validateCreditAdminGrantCents(
			parseDollarsToCents(amountText) ?? Number.NaN,
		)
		if (!amount.ok) {
			setMessage(amount.error)
			setMessageTone('error')

			return
		}
		const note = noteText.trim()
		if (note.length > creditAdminGrantNoteMaxLength) {
			setMessage(
				`Keep the note under ${creditAdminGrantNoteMaxLength} characters.`,
			)
			setMessageTone('error')

			return
		}
		setMessage(null)
		grant.mutate(
			{
				stableUserId: props.stableUserId,
				amountCents: amount.cents,
				note: note || undefined,
				actorKey,
			},
			{
				onSuccess: () => {
					setAmountText('')
					setNoteText('')
					setMessage(`Granted ${formatCents(amount.cents)}.`)
					setMessageTone('info')
					props.onGranted?.()
				},
				onError: (error) => {
					setMessage(error.message)
					setMessageTone('error')
				},
			},
		)
	}

	return (
		<AccountManagementPanel
			title="Credits"
			description="Prepaid wallet. Grants add to the balance immediately and are recorded with your username."
		>
			{status === 'loading' && !wallet ? (
				<p css={{ margin: 0, color: colors.textMuted }}>Loading credits…</p>
			) : null}
			{message || walletQuery.error ? (
				<AccountManagementMessage tone={messageTone}>
					{message ?? walletQuery.error?.message}
				</AccountManagementMessage>
			) : null}
			{wallet ? (
				<>
					<MetadataGrid
						items={[
							{
								label: 'Balance',
								value: (
									<span
										data-admin-credits-balance
										css={{
											fontVariantNumeric: 'tabular-nums',
											color:
												wallet.balanceMicroUsd < 0 ? colors.error : colors.text,
										}}
									>
										{formatMicroUsd(wallet.balanceMicroUsd)}
									</span>
								),
							},
							{
								label: 'Credit wallet',
								value: wallet.eligible
									? 'Eligible (Pro)'
									: `Not eligible (${wallet.plan})`,
							},
							{
								label: 'Admin eligibility',
								value: wallet.adminCreditsEligible ? 'On' : 'Off',
							},
							{
								label: 'Past include',
								value: wallet.unlocked
									? 'Runs on credits'
									: wallet.eligible
										? 'Stops (no credits)'
										: 'Plan hard caps',
							},
						]}
					/>
					<form
						method="post"
						noValidate
						aria-label="Grant credits"
						onSubmit={(event: FormEvent<HTMLFormElement>) =>
							void submitGrant(event)
						}
						css={{
							display: 'grid',
							gap: spacing.md,
							gridTemplateColumns: 'minmax(0, 10rem) minmax(0, 1fr) auto',
							alignItems: 'end',
							[mq.mobile]: { gridTemplateColumns: '1fr' },
						}}
					>
						<label css={fieldCss}>
							<span css={fieldLabelCss}>Amount ($)</span>
							<input
								type="text"
								inputMode="decimal"
								autoComplete="off"
								value={amountText}
								disabled={granting}
								data-field-ring
								onInput={(event) => {
									setAmountText((event.currentTarget as HTMLInputElement).value)
								}}
								css={inputCss}
							/>
						</label>
						<label css={fieldCss}>
							<span css={fieldLabelCss}>Note (optional)</span>
							<input
								type="text"
								autoComplete="off"
								maxLength={creditAdminGrantNoteMaxLength}
								value={noteText}
								disabled={granting}
								data-field-ring
								onInput={(event) => {
									setNoteText((event.currentTarget as HTMLInputElement).value)
								}}
								css={inputCss}
							/>
						</label>
						<button
							type="submit"
							disabled={granting || amountText.trim() === ''}
							css={primaryButtonCss}
						>
							{granting ? 'Granting…' : 'Grant'}
						</button>
					</form>
					{wallet.recent.length === 0 ? (
						<p css={{ margin: 0, color: colors.textMuted }}>
							No credit activity yet.
						</p>
					) : (
						<ul
							aria-label="Recent credit activity"
							css={{
								margin: 0,
								padding: 0,
								listStyle: 'none',
								display: 'grid',
								gap: spacing.sm,
							}}
						>
							{wallet.recent.map((item) => (
								<li
									key={item.id}
									data-admin-credits-ledger-kind={item.kind}
									css={{
										display: 'grid',
										gap: '0.15rem',
										fontSize: typography.fontSize.sm,
									}}
								>
									<span
										css={{
											display: 'flex',
											flexWrap: 'wrap',
											gap: spacing.sm,
											fontVariantNumeric: 'tabular-nums',
										}}
									>
										<strong>{ledgerKindLabels[item.kind]}</strong>
										<span>{formatSignedMicroUsd(item.amountMicroUsd)}</span>
										<span css={{ color: colors.textMuted }}>
											{formatTimestampDate(item.createdAt)}
										</span>
									</span>
									{item.kind === 'admin_grant' ? (
										<span css={{ color: colors.textMuted }}>
											by{' '}
											{item.grantedByUsername ??
												(item.id.startsWith(signupWelcomeCreditLedgerIdPrefix)
													? 'signup'
													: 'unknown admin')}
											{item.note ? ` — ${item.note}` : ''}
										</span>
									) : (
										<span css={{ color: colors.textMuted }}>
											{item.description}
										</span>
									)}
								</li>
							))}
						</ul>
					)}
				</>
			) : null}
		</AccountManagementPanel>
	)
}
const inputCss = { ...getAuthInputCss(), width: '100%' }
const primaryButtonCss = getPillButtonCss({ size: 'sm' })

const mutationResources = [
	'loadAdminUsers',
	'loadUsagePage',
	'loadBillingPage',
] as const
