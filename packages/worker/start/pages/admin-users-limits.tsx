/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { useState, useRef, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	adminOrgLimitsQuery,
	adminOrgLimitMutationOptions,
	type LimitChange,
} from '../admin-user-controls-query.ts'
import { formatIntegerNumber } from '#client/charts/chart-theme.ts'
import { formatTimestampDate } from '../components/local-timestamp.tsx'
import { type AdminOrgLimits } from '#universal/loader-data.ts'
type AdminOrgLimitRow = AdminOrgLimits['limits'][number]
import {
	isUnlimitedLimit,
	limitOverrideKeys,
	type LimitOverrideKey,
	type LimitOverrideValue,
} from '#universal/plans.ts'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getAuthInputCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
} from './account-management-components.tsx'

function formatLimit(limit: number | null) {
	if (limit === null) return 'No window'
	return isUnlimitedLimit(limit) ? 'Unlimited' : formatIntegerNumber(limit)
}

function formatOverrideValue(value: LimitOverrideValue) {
	return value === 'unlimited' ? 'Unlimited' : formatIntegerNumber(value)
}

function parseValueText(text: string): LimitOverrideValue | null {
	const trimmed = text.trim().toLowerCase()
	if (trimmed === 'unlimited') return 'unlimited'
	const value = Number(trimmed.replaceAll(',', '').replaceAll('_', ''))
	return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Admin limit overrides for one org: plan vs effective caps, and a form to
 * set, change, or remove an override with a reason. Every change is
 * recorded in the org audit log.
 */
export function AdminOrgLimitsPanel({ orgId }: { orgId: string }) {
	const { actorKey } = useRouteContext({ from: '__root__' })
	const client = useQueryClient()
	const query = useQuery(adminOrgLimitsQuery(actorKey, orgId))
	const limits = query.data
	const mutation = useMutation(adminOrgLimitMutationOptions(client))
	const capture = useSubmitterScope()
	const saving = mutation.isPending
	const busy = useRef(false)
	const [key, setKey] = useState<LimitOverrideKey>(limitOverrideKeys[0])
	const [valueText, setValueText] = useState('')
	const [expiresText, setExpiresText] = useState('')
	const [reasonText, setReasonText] = useState('')
	const [message, setMessage] = useState<string | null>(null)
	const [messageTone, setMessageTone] = useState<'info' | 'error'>('info')
	async function save(change: LimitChange) {
		if (busy.current) return
		if (!reasonText.trim()) {
			setMessage('A reason is required.')
			setMessageTone('error')
			return
		}
		busy.current = true
		setMessage(null)
		const isCurrent = capture()
		try {
			await mutation.mutateAsync({
				actorKey,
				orgId,
				change,
				reason: reasonText.trim(),
			})
			if (isCurrent()) {
				setMessage(
					change.value === null ? 'Override removed.' : 'Override saved.',
				)
				setMessageTone('info')
				setValueText('')
				setExpiresText('')
			}
		} catch (error) {
			if (isCurrent()) {
				setMessage(
					error instanceof Error
						? error.message
						: 'Unable to save the override.',
				)
				setMessageTone('error')
			}
		} finally {
			busy.current = false
		}
	}
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const value = parseValueText(valueText)
		if (value === null) {
			setMessage('Enter a whole number or "unlimited".')
			setMessageTone('error')
			return
		}
		const date = expiresText ? new Date(expiresText) : null
		if (date && Number.isNaN(date.getTime())) {
			setMessage('Enter a valid expiration date.')
			setMessageTone('error')
			return
		}
		void save({ key, value, expiresAt: date?.toISOString() ?? null })
	}

	function renderRow(row: AdminOrgLimitRow) {
		return (
			<tr key={row.key} data-admin-org-limit={row.key}>
				<td css={cellCss}>{row.label}</td>
				<td css={numberCellCss}>{formatLimit(row.planLimit)}</td>
				<td css={numberCellCss} data-admin-org-limit-effective>
					{formatLimit(row.effectiveLimit)}
				</td>
				<td css={cellCss}>
					{row.override ? (
						<span css={{ display: 'grid', gap: '0.15rem' }}>
							<span>
								{formatOverrideValue(row.override.value)}
								{row.override.active ? '' : ' (expired)'}
								{row.override.expiresAt
									? ` until ${formatTimestampDate(row.override.expiresAt)}`
									: ''}
							</span>
							<span css={{ color: colors.textMuted }}>
								{row.override.reason}
							</span>
							<button
								type="button"
								disabled={saving}
								css={removeButtonCss}
								onClick={() =>
									void save({ key: row.key, value: null, expiresAt: null })
								}
							>
								Remove
							</button>
						</span>
					) : (
						<span css={{ color: colors.textMuted }}>None</span>
					)}
				</td>
			</tr>
		)
	}

	return (
		<AccountManagementPanel
			title="Limit overrides"
			description="Raise any daily, weekly, or monthly cap for this org. The enforced limit is the larger of the plan limit and the override. Credits and billing are unchanged. Every change is recorded in the org audit log with your username and the reason."
		>
			{message || query.error ? (
				<AccountManagementMessage tone={query.error ? 'error' : messageTone}>
					{message ?? query.error?.message}
				</AccountManagementMessage>
			) : null}
			{limits ? (
				<>
					<div css={{ overflowX: 'auto' }}>
						<table
							aria-label="Org limits"
							css={{
								width: '100%',
								borderCollapse: 'collapse',
								fontSize: typography.fontSize.sm,
							}}
						>
							<thead>
								<tr>
									<th css={headCss}>Limit</th>
									<th css={headCss}>Plan</th>
									<th css={headCss}>Effective</th>
									<th css={headCss}>Override</th>
								</tr>
							</thead>
							<tbody>{limits.limits.map(renderRow)}</tbody>
						</table>
					</div>
					<form
						noValidate
						aria-label="Set limit override"
						css={{
							display: 'grid',
							gap: spacing.md,
							gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
							alignItems: 'end',
							[mq.mobile]: { gridTemplateColumns: '1fr' },
						}}
						onSubmit={submit}
					>
						<label css={fieldCss}>
							<span css={fieldLabelCss}>Limit</span>
							<select
								value={key}
								disabled={saving}
								css={inputCss}
								onChange={(event) =>
									setKey(event.currentTarget.value as LimitOverrideKey)
								}
							>
								{limits.limits.map((row) => (
									<option key={row.key} value={row.key}>
										{row.label}
									</option>
								))}
							</select>
						</label>
						<label css={fieldCss}>
							<span css={fieldLabelCss}>Value (or "unlimited")</span>
							<input
								type="text"
								autoComplete="off"
								value={valueText}
								disabled={saving}
								data-field-ring
								css={inputCss}
								onChange={(event) => setValueText(event.currentTarget.value)}
							/>
						</label>
						<label css={fieldCss}>
							<span css={fieldLabelCss}>Expires (optional)</span>
							<input
								type="datetime-local"
								value={expiresText}
								disabled={saving}
								data-field-ring
								css={inputCss}
								onChange={(event) => setExpiresText(event.currentTarget.value)}
							/>
						</label>
						<label css={fieldCss}>
							<span css={fieldLabelCss}>Reason (required)</span>
							<input
								type="text"
								autoComplete="off"
								maxLength={500}
								value={reasonText}
								disabled={saving}
								data-field-ring
								css={inputCss}
								onChange={(event) => setReasonText(event.currentTarget.value)}
							/>
						</label>
						<button
							type="submit"
							disabled={saving || valueText.trim() === ''}
							css={primaryButtonCss}
						>
							{saving ? 'Saving…' : 'Save override'}
						</button>
					</form>
				</>
			) : message || query.error ? null : (
				<p css={{ margin: 0, color: colors.textMuted }}>Loading limits…</p>
			)}
		</AccountManagementPanel>
	)
}

const inputCss: CSSObject = { ...getAuthInputCss(), width: '100%' }
const primaryButtonCss: CSSObject = getPillButtonCss({ size: 'sm' })
const removeButtonCss: CSSObject = {
	...getGhostButtonCss({ size: 'sm' }),
	justifySelf: 'start',
}
const headCss: CSSObject = {
	textAlign: 'left',
	padding: `${spacing.xs} ${spacing.sm}`,
	color: colors.textMuted,
	fontWeight: typography.fontWeight.medium,
} as const
const cellCss: CSSObject = {
	padding: `${spacing.xs} ${spacing.sm}`,
	verticalAlign: 'top',
	borderTop: `1px solid ${colors.border}`,
} as const
const numberCellCss: CSSObject = {
	...cellCss,
	fontVariantNumeric: 'tabular-nums',
} as const
