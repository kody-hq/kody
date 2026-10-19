/** @jsxImportSource @emotion/react */
import { useRouteContext } from '@tanstack/react-router'
import { AdminOrgLimitsPanel } from './admin-users-limits.tsx'
import { AdminUserDestinationPanel } from './admin-users-destination-panel.tsx'
import { useState } from 'react'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getGhostButtonCss,
	getPillButtonCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	IdValue,
	MetadataGrid,
	TimestampValue,
	noticeCardCss,
} from './account-management-components.tsx'
import { RecordTable, recordBodyCss } from './record-table.tsx'
import { ChartLegend } from '../components/chart-legend.tsx'
import { StackedBarChart } from '../components/stacked-bar-chart.tsx'
import { chartColor, formatIntegerNumber } from '#client/charts/chart-theme.ts'
import {
	formatMonthKeyLabel,
	usageMetricSeries,
} from '#client/charts/usage-metric-series.ts'
import { type RoleName } from '#universal/permissions.ts'
import {
	type AdminPlanName,
	type AdminUserListItem,
	type AdminUserUsageLoaderData,
} from '#universal/loader-data.ts'
import { describeEmailVerificationDelivery } from '#universal/email-verification-delivery.ts'
import {
	formatUsageLimit,
	formatUsagePercent,
} from '#client/routes/admin-users-shared.ts'
import { AdminUserCreditsPanel } from './admin-users-credits.tsx'
import { AdminUserAccountModeration } from './admin-account-delete-dialog.tsx'
import {
	costVsPayFootnote,
	formatDynamicWorkerUsd,
} from '#universal/dynamic-worker-cost.ts'
import {
	formatAdminCostRiskStatus,
	formatUsdFromCents,
} from '#client/routes/admin-insights-shared.ts'
import {
	durableObjectDurationFootnote,
	measuredDurableObjectDurationFootnote,
	formatDurableObjectGbSeconds,
} from '#universal/durable-object-duration.ts'
const selectCss = getSelectCss()
const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
export type AdminUsersActionState =
	| 'idle'
	| 'assigning'
	| 'removing'
	| 'saving-plan'
	| 'moderating'
	| 'verifying'
	| 'creatingUser'
export type AdminUserDetailProps = {
	selectedUser: AdminUserListItem
	availableRoles: Array<RoleName>
	availablePlans: Array<AdminPlanName>
	actionState: AdminUsersActionState
	selectedRoleToAssign: RoleName
	selectedPlanChoice: AdminPlanName
	mintedVerifyUrl: string | null
	mintedVerifyUrlForStableUserId: string | null
	usageStatus: 'loading' | 'ready' | 'error'
	usageMessage: string | null
	usageFailedForStableUserId: string | null
	selectedUsage: AdminUserUsageLoaderData | null
	onRoleToAssignChange: (role: RoleName) => void
	onSubmitRoleAction: (action: 'assign_role' | 'remove_role') => void
	onSubmitVerificationAction: (
		action: 'mark_email_verified' | 'mint_verify_url',
	) => void
	onPlanChoiceChange: (plan: AdminPlanName) => void
	onSubmitPlanAction: () => void
	onCreditsGranted: () => void
	onSubmitModerationAction: (
		action: 'suspend_user' | 'unsuspend_user' | 'resume_email_outbound',
	) => void
	onAccountDeleted: (handle: string) => void
}
export function AdminUserDetail(props: AdminUserDetailProps) {
	const { selectedUser, actionState, selectedUsage } = props
	const { actorKey } = useRouteContext({ from: '__root__' })
	const [markVerifiedArmed, setMarkVerifiedArmed] = useState(false)
	const isMutating = actionState !== 'idle'
	const usageMonthsAscending = selectedUsage
		? [...selectedUsage.monthUsage].reverse()
		: []
	return (
		<div css={recordBodyCss}>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<h2
					css={{
						margin: 0,
						fontSize: typography.fontSize.lg,
						fontWeight: typography.fontWeight.semibold,
					}}
				>
					{selectedUser.username}
				</h2>
				<p css={{ margin: 0, color: colors.textMuted }}>
					Account metadata only, no secrets, packages, or other user content
					appears on this page.
				</p>
			</div>
			<MetadataGrid
				items={[
					{ label: 'Email', value: selectedUser.email },
					{
						label: 'Email verified',
						value: selectedUser.email_verified
							? (selectedUser.email_verified_at ?? 'Verified')
							: 'No',
					},
					{
						label: 'Verification mail',
						value: selectedUser.email_verification_delivery
							? [
									selectedUser.email_verification_delivery.status,
									selectedUser.email_verification_delivery.class,
									selectedUser.email_verification_delivery_detail,
								]
									.filter(Boolean)
									.join(' · ')
							: 'Not tracked',
					},
					{
						label: 'First-touch UTMs',
						value:
							[
								selectedUser.utm_source && `source=${selectedUser.utm_source}`,
								selectedUser.utm_medium && `medium=${selectedUser.utm_medium}`,
								selectedUser.utm_campaign &&
									`campaign=${selectedUser.utm_campaign}`,
								selectedUser.utm_content &&
									`content=${selectedUser.utm_content}`,
								selectedUser.utm_term && `term=${selectedUser.utm_term}`,
							]
								.filter(Boolean)
								.join(' · ') || 'None',
					},
					{
						label: 'Landing path',
						value: selectedUser.first_touch_landing_path ?? 'None',
					},
					{
						label: 'Referrer',
						value: selectedUser.first_touch_referrer ?? 'None',
					},
					{
						label: 'First MCP connected',
						value: selectedUser.first_mcp_connected_at ?? 'Not yet',
					},
					{
						label: 'MCP client',
						value: selectedUser.mcp_client_name ?? 'Unknown',
					},
					{
						label: 'First execute',
						value: selectedUser.first_execute_at ?? 'Not yet',
					},
					{
						label: 'First search',
						value: selectedUser.first_search_at ?? 'Not yet',
					},
					{
						label: 'First saved package',
						value: selectedUser.first_saved_package_at ?? 'Not yet',
					},
					{
						label: 'Last active',
						value: selectedUser.last_active_at ?? 'Unknown',
					},
					{
						label: 'Stable user id',
						value: (
							<IdValue
								value={selectedUser.stableUserId}
								label="stable user id"
							/>
						),
					},
					{
						label: 'Roles',
						value:
							selectedUser.roles.length > 0
								? selectedUser.roles.join(', ')
								: 'None',
					},
					{
						label: 'Admin grant',
						value: selectedUser.plan ?? 'free',
					},
					{
						label: 'Subscription plan',
						value: selectedUser.stripePlan ?? 'None',
					},
					{
						label: 'Effective plan',
						value: selectedUser.effectivePlan ?? 'free',
					},
					{
						label: 'Entitlement ladder',
						value:
							selectedUser.entitlementLadder === 'legacy'
								? 'Legacy (pre-cut Standard/Pro ceilings)'
								: 'Public',
					},
					{
						label: 'Stripe customer',
						value: selectedUser.stripeCustomerLinked ? 'Linked' : 'Not linked',
					},
					{
						label: 'Suspended',
						value: (
							<TimestampValue value={selectedUser.suspended_at} fallback="No" />
						),
					},
					{
						label: 'Outbound email',
						value: selectedUser.email_outbound_paused_at ? (
							<>
								Paused{' '}
								<TimestampValue value={selectedUser.email_outbound_paused_at} />
							</>
						) : (
							'Active'
						),
					},
					{
						label: 'Created',
						value: <TimestampValue value={selectedUser.created_at} />,
					},
					{
						label: 'Updated',
						value: <TimestampValue value={selectedUser.updated_at} />,
					},
				]}
			/>
			<AccountManagementPanel title="Manage roles">
				<div
					css={{
						display: 'grid',
						gap: spacing.md,
						gridTemplateColumns: 'minmax(0, 1fr) auto auto',
						alignItems: 'end',
						[mq.mobile]: { gridTemplateColumns: '1fr' },
					}}
				>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Role</span>
						<select
							data-field-ring
							value={props.selectedRoleToAssign}
							disabled={isMutating}
							aria-label="Role"
							onChange={(event) => {
								props.onRoleToAssignChange(
									event.currentTarget.value as RoleName,
								)
							}}
							css={selectCss}
						>
							{props.availableRoles.map((role) => (
								<option key={role} value={role}>
									{role}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						disabled={isMutating}
						onClick={() => props.onSubmitRoleAction('assign_role')}
						css={primaryButtonCss}
					>
						{actionState === 'assigning' ? 'Assigning…' : 'Assign'}
					</button>
					<button
						type="button"
						disabled={
							isMutating ||
							!selectedUser.roles.includes(props.selectedRoleToAssign)
						}
						onClick={() => props.onSubmitRoleAction('remove_role')}
						css={secondaryButtonCss}
					>
						{actionState === 'removing' ? 'Removing…' : 'Remove'}
					</button>
				</div>
			</AccountManagementPanel>
			{!selectedUser.email_verified ? (
				<AccountManagementPanel
					title="Email verification"
					description="Mark verified after the person proves they own the address (for example they mailed kody@ from it), or mint a one-time link to send over a path that is not kody.codes."
				>
					{selectedUser.email_verification_delivery ? (
						<p
							css={{
								margin: 0,
								color:
									describeEmailVerificationDelivery(
										selectedUser.email_verification_delivery,
									).tone === 'error'
										? colors.error
										: colors.textMuted,
							}}
						>
							{describeEmailVerificationDelivery(
								selectedUser.email_verification_delivery,
							).headline ?? selectedUser.email_verification_delivery.status}
							{selectedUser.email_verification_delivery_detail
								? ` — ${selectedUser.email_verification_delivery_detail}`
								: ''}
						</p>
					) : null}
					<div
						css={{
							display: 'flex',
							gap: spacing.md,
							flexWrap: 'wrap',
						}}
					>
						<button
							type="button"
							disabled={isMutating}
							onClick={() => {
								if (!markVerifiedArmed) {
									setMarkVerifiedArmed(true)
									return
								}
								setMarkVerifiedArmed(false)
								props.onSubmitVerificationAction('mark_email_verified')
							}}
							onBlur={() => setMarkVerifiedArmed(false)}
							css={primaryButtonCss}
						>
							{actionState === 'verifying'
								? 'Working…'
								: markVerifiedArmed
									? 'Confirm mark verified'
									: 'Mark email verified'}
						</button>
						<button
							type="button"
							disabled={isMutating}
							onClick={() =>
								props.onSubmitVerificationAction('mint_verify_url')
							}
							css={secondaryButtonCss}
						>
							{actionState === 'verifying' ? 'Working…' : 'Mint verify link'}
						</button>
					</div>
					{props.mintedVerifyUrl &&
					props.mintedVerifyUrlForStableUserId === selectedUser.stableUserId ? (
						<label css={fieldCss}>
							<span css={fieldLabelCss}>One-time verify URL</span>
							<input
								data-field-ring
								readOnly
								value={props.mintedVerifyUrl}
								aria-label="One-time verify URL"
								css={{
									width: '100%',
									fontFamily: typography.fontFamilyMono,
								}}
							/>
						</label>
					) : null}
				</AccountManagementPanel>
			) : null}
			<AdminUserDestinationPanel
				key={`destination-${actorKey}-${selectedUser.stableUserId}`}
				stableUserId={selectedUser.stableUserId}
			/>
			<AccountManagementPanel
				title="Manage plan"
				description="Sets the admin grant (users.plan). Ordinary Stripe subscribers keep this as free; their paid tier lives on the subscription plan. The effective plan is the higher of the two."
			>
				<div
					css={{
						display: 'grid',
						gap: spacing.md,
						gridTemplateColumns: 'minmax(0, 1fr) auto',
						alignItems: 'end',
						[mq.mobile]: { gridTemplateColumns: '1fr' },
					}}
				>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Admin grant</span>
						<select
							data-field-ring
							disabled={isMutating}
							aria-label="Admin grant"
							value={props.selectedPlanChoice}
							onChange={(event) => {
								props.onPlanChoiceChange(
									event.currentTarget.value as AdminPlanName,
								)
							}}
							css={selectCss}
						>
							{props.availablePlans.map((plan) => (
								<option key={plan} value={plan}>
									{plan}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						disabled={
							isMutating ||
							props.selectedPlanChoice === (selectedUser.plan ?? 'free')
						}
						onClick={() => props.onSubmitPlanAction()}
						css={primaryButtonCss}
					>
						{actionState === 'saving-plan' ? 'Saving…' : 'Save grant'}
					</button>
				</div>
			</AccountManagementPanel>
			<AdminUserCreditsPanel
				key={selectedUser.stableUserId}
				stableUserId={selectedUser.stableUserId}
				onGranted={props.onCreditsGranted}
			/>
			<AdminOrgLimitsPanel
				key={`limits-${actorKey}-${selectedUser.stableUserId}`}
				orgId={selectedUser.stableUserId}
			/>
			<AccountManagementPanel
				title="Moderation"
				description="Suspension blocks the account at the session, MCP, and email chokepoints. The outbound-email pause is set automatically after spam complaints or repeated bounces."
			>
				<AdminUserAccountModeration
					stableUserId={selectedUser.stableUserId}
					username={selectedUser.username}
					suspendedAt={selectedUser.suspended_at}
					emailOutboundPausedAt={selectedUser.email_outbound_paused_at}
					parentMutating={isMutating}
					onSubmitModerationAction={props.onSubmitModerationAction}
					onDeleted={props.onAccountDeleted}
				/>
			</AccountManagementPanel>
			<AccountManagementPanel
				title="Usage & quotas"
				description="Metered usage rollups and entitlement consumption for this account. Warnings appear above 80% of a numeric limit."
			>
				{!selectedUsage && props.usageStatus === 'loading' ? (
					<p css={{ margin: 0, color: colors.textMuted }}>Loading usage…</p>
				) : null}
				{props.usageStatus === 'error' &&
				props.usageFailedForStableUserId === selectedUser.stableUserId &&
				props.usageMessage ? (
					<AccountManagementMessage tone="error">
						{props.usageMessage}
					</AccountManagementMessage>
				) : null}
				{selectedUsage ? (
					<>
						{selectedUsage.warnings.length > 0 ? (
							<div css={noticeCardCss}>
								<strong>Quota watch:</strong>{' '}
								{selectedUsage.warnings
									.map(
										(item) =>
											`${item.label} at ${formatUsagePercent(item.percentOfLimit)}`,
									)
									.join(', ')}
							</div>
						) : null}
						<div css={{ display: 'grid', gap: spacing.sm }}>
							<h3
								css={{
									margin: 0,
									fontSize: typography.fontSize.base,
								}}
							>
								Cloudflare Dynamic Worker cost
							</h3>
							<p
								css={{
									margin: 0,
									fontSize: typography.fontSize.sm,
									fontVariantNumeric: 'tabular-nums',
								}}
							>
								{formatDynamicWorkerUsd(
									selectedUsage.costVsPay.estimatedGrossUsd,
								)}{' '}
								est. cost ·{' '}
								{formatUsdFromCents(
									selectedUsage.costVsPay.estimatedPaidUsdCents,
								)}{' '}
								list pay ·{' '}
								<span
									css={{
										color:
											selectedUsage.costVsPay.risk === 'paid_underwater'
												? colors.danger
												: selectedUsage.costVsPay.risk === 'free_near_allotment'
													? colors.warningText
													: colors.textMuted,
									}}
								>
									{formatAdminCostRiskStatus({
										risk: selectedUsage.costVsPay.risk,
										estimatedGrossUsd:
											selectedUsage.costVsPay.estimatedGrossUsd,
										estimatedPaidUsdCents:
											selectedUsage.costVsPay.estimatedPaidUsdCents,
									})}
								</span>{' '}
								({formatIntegerNumber(selectedUsage.costVsPay.uniqueWorkerDays)}{' '}
								unique worker-days)
							</p>
							<p
								css={{
									margin: 0,
									color: colors.textMuted,
									fontSize: typography.fontSize.xs,
								}}
							>
								{costVsPayFootnote}
							</p>
						</div>
						<div css={{ display: 'grid', gap: spacing.sm }}>
							<h3
								css={{
									margin: 0,
									fontSize: typography.fontSize.base,
								}}
							>
								Durable Object duration
							</h3>
							<p
								css={{
									margin: 0,
									fontSize: typography.fontSize.sm,
									fontVariantNumeric: 'tabular-nums',
								}}
							>
								{formatDurableObjectGbSeconds(
									selectedUsage.durableObjectDuration.gbSeconds,
								)}{' '}
								this month (
								{formatIntegerNumber(
									selectedUsage.durableObjectDuration.rpcCount,
								)}{' '}
								RPCs)
							</p>
							<p
								css={{
									margin: 0,
									color: colors.textMuted,
									fontSize: typography.fontSize.xs,
								}}
							>
								{durableObjectDurationFootnote}
							</p>
							<p
								css={{
									margin: 0,
									fontSize: typography.fontSize.sm,
									fontVariantNumeric: 'tabular-nums',
								}}
							>
								Cloudflare-measured:{' '}
								{formatDurableObjectGbSeconds(
									selectedUsage.durableObjectDuration.measured.gbSeconds,
								)}{' '}
								(~$
								{selectedUsage.durableObjectDuration.measured.estimatedUsd.toFixed(
									2,
								)}{' '}
								gross)
								{selectedUsage.durableObjectDuration.measured.lastDay
									? ` through ${selectedUsage.durableObjectDuration.measured.lastDay}`
									: ' — no attributed days yet'}
							</p>
							{selectedUsage.durableObjectDuration.measured.byClass.length >
							0 ? (
								<p
									css={{
										margin: 0,
										fontSize: typography.fontSize.xs,
										fontVariantNumeric: 'tabular-nums',
									}}
								>
									{selectedUsage.durableObjectDuration.measured.byClass
										.map(
											(row) =>
												`${row.doClass} ${formatDurableObjectGbSeconds(row.gbSeconds)}`,
										)
										.join(' · ')}
								</p>
							) : null}
							<p
								css={{
									margin: 0,
									color: colors.textMuted,
									fontSize: typography.fontSize.xs,
								}}
							>
								{measuredDurableObjectDurationFootnote}
							</p>
						</div>
						<div css={{ display: 'grid', gap: spacing.md }}>
							<h3
								css={{
									margin: 0,
									fontSize: typography.fontSize.base,
								}}
							>
								Monthly activity
							</h3>
							<StackedBarChart
								id="admin-user-usage"
								ariaLabel={`Metered events by month for ${selectedUsage.username}`}
								series={usageMetricSeries.map((entry) => ({
									label: entry.label,
									color: entry.color,
									values: usageMonthsAscending.map(
										(month) =>
											month.usage.find((row) => row.metric === entry.metric)
												?.eventCount ?? 0,
									),
								}))}
								xLabels={usageMonthsAscending.map((month) =>
									formatMonthKeyLabel(month.month),
								)}
								viewBoxWidth={560}
								height={200}
							/>
							<ChartLegend
								items={usageMetricSeries.map((entry) => ({
									label: entry.label,
									color: entry.color,
									value: formatIntegerNumber(
										selectedUsage.currentMonthUsage.find(
											(row) => row.metric === entry.metric,
										)?.eventCount ?? 0,
									),
								}))}
							/>
							<p
								css={{
									margin: 0,
									color: colors.textMuted,
									fontSize: typography.fontSize.xs,
								}}
							>
								Legend counts are for the current month (
								{selectedUsage.currentMonth}).
							</p>
						</div>
						<div css={{ display: 'grid', gap: spacing.md }}>
							<h3
								css={{
									margin: 0,
									fontSize: typography.fontSize.base,
								}}
							>
								Entitlements
							</h3>
							<RecordTable
								mode="none"
								ariaLabel="Entitlement consumption"
								// The list is short and already sits inside an
								// expanded record; a nested scroller would be a
								// second thing to fight on the way down the page.
								scrollHeight="none"
								columns={[
									{
										key: 'resource',
										label: 'Resource',
										primary: true,
									},
									{ key: 'current', label: 'In use', align: 'end' },
									{ key: 'limit', label: 'Limit', align: 'end' },
									{ key: 'used', label: 'Used', align: 'end' },
								]}
								rows={selectedUsage.entitlementConsumption.map((item) => ({
									id: item.resource,
									cells: {
										resource: item.label,
										current:
											item.current === null
												? 'Not measured'
												: formatIntegerNumber(item.current),
										limit: formatUsageLimit(item.limit),
										used: (
											<span
												css={
													item.overEightyPercent
														? {
																color: chartColor.amber,
																fontWeight: typography.fontWeight.semibold,
															}
														: {}
												}
											>
												{formatUsagePercent(item.percentOfLimit)}
											</span>
										),
									},
								}))}
							/>
						</div>
					</>
				) : null}
			</AccountManagementPanel>
		</div>
	)
}
