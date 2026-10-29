/** @jsxImportSource @emotion/react */
import { useRouter } from '@tanstack/react-router'
import { formatMicroUsd } from '#universal/credits.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import { isWithinSoftDeleteRestoreWindow } from '#worker/soft-delete/window.ts'
import {
	type AdminOrgDetail,
	type AdminOrgsData,
	type AdminOrgStatus,
	type AdminOrgKind,
} from '#worker/admin/orgs-data.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountManagementMessage,
	AdminPageHeader,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import { AdminOrgLimitsPanel } from './admin-users-limits.tsx'
import {
	formatAdminCreditLedgerKind,
	formatAdminEntitlementLadder,
	formatAdminOrganizationRole,
} from './admin-display-labels.ts'
import {
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
} from './record-table.tsx'

export function AdminOrgsPage(props: {
	payload: AdminOrgsData
	currentHref: string
	status: AdminOrgStatus
	kind: AdminOrgKind | 'all'
	query: string
}) {
	const router = useRouter()
	function updateFilters(next: {
		query?: string
		status?: string
		kind?: string
	}) {
		const url = new URL(props.currentHref, 'http://localhost')
		// Each filter drops its own default from the URL: status defaults to
		// `live` (so `all` must stay), kind defaults to `all`.
		const defaults: Record<string, string> = { status: 'live', kind: 'all' }
		for (const [key, value] of Object.entries(next)) {
			if (!value || value === defaults[key])
				url.searchParams.delete(key === 'query' ? 'q' : key)
			else url.searchParams.set(key === 'query' ? 'q' : key, value)
		}
		url.searchParams.delete('page')
		void router.navigate({
			href: `${url.pathname}${url.search}`,
			replace: true,
		})
	}
	return (
		<AccountManagementShell layout="list" currentHref={props.currentHref}>
			<AdminPageHeader
				title="Organizations"
				description="Review organization plans, seats, credits, budgets, and lifecycle state."
				currentHref={props.currentHref}
			/>
			<RecordTable
				mode="none"
				ariaLabel="Organizations"
				countLabel={`${props.payload.items.length} of ${props.payload.total} organizations`}
				emptyLabel="No organizations match the current filters."
				toolbar={
					<>
						<RecordTableSearch
							label="Search organizations"
							placeholder="Search slug or display name"
							value={props.query}
							onInput={(query) => updateFilters({ query })}
						/>
						<RecordTableSelect
							label="Filter organizations by status"
							value={props.status}
							onChange={(status) => updateFilters({ status })}
						>
							<option value="live">Live</option>
							<option value="deleted">Deleted</option>
							<option value="all">All</option>
						</RecordTableSelect>
						<RecordTableSelect
							label="Filter organizations by kind"
							value={props.kind}
							onChange={(kind) => updateFilters({ kind })}
						>
							<option value="all">All kinds</option>
							<option value="personal">Personal</option>
							<option value="team">Team</option>
						</RecordTableSelect>
					</>
				}
				columns={[
					{ key: 'organization', label: 'Organization', primary: true },
					{ key: 'kind', label: 'Kind' },
					{ key: 'plan', label: 'Plan' },
					{ key: 'seats', label: 'Seats', align: 'end' },
					{ key: 'credits', label: 'Credits', align: 'end' },
					{ key: 'state', label: 'State' },
				]}
				rows={props.payload.items.map((org) => ({
					id: org.slug,
					href: `/admin/orgs/${encodeURIComponent(org.slug)}`,
					cells: {
						organization: (
							<span css={{ display: 'grid' }}>
								<span>{org.displayName || `@${org.slug}`}</span>
								{org.kind === 'team' ? (
									<span css={{ color: colors.textMuted }}>@{org.slug}</span>
								) : null}
							</span>
						),
						kind: org.kind === 'personal' ? 'Personal' : 'Team',
						plan: org.effectivePlan,
						seats: org.seats,
						credits:
							org.creditBalanceMicroUsd == null
								? '—'
								: formatMicroUsd(org.creditBalanceMicroUsd),
						state: org.deletedAt
							? 'Deleted'
							: org.suspendedAt
								? 'Suspended'
								: 'Live',
					},
				}))}
			/>
			{props.payload.total > props.payload.pageSize ? (
				<div
					css={{
						display: 'flex',
						justifyContent: 'space-between',
						color: colors.textMuted,
						padding: spacing.sm,
					}}
				>
					<span>Page {props.payload.page}</span>
					<div css={{ display: 'flex', gap: spacing.sm }}>
						<button
							type="button"
							disabled={props.payload.page <= 1}
							onClick={() => {
								const url = new URL(props.currentHref, 'http://localhost')
								url.searchParams.set('page', String(props.payload.page - 1))
								void router.navigate({
									href: `${url.pathname}${url.search}`,
									replace: true,
								})
							}}
						>
							Previous
						</button>
						<button
							type="button"
							disabled={
								props.payload.page * props.payload.pageSize >=
								props.payload.total
							}
							onClick={() => {
								const url = new URL(props.currentHref, 'http://localhost')
								url.searchParams.set('page', String(props.payload.page + 1))
								void router.navigate({
									href: `${url.pathname}${url.search}`,
									replace: true,
								})
							}}
						>
							Next
						</button>
					</div>
				</div>
			) : null}
		</AccountManagementShell>
	)
}

export function AdminOrgDetailPage(props: {
	payload: AdminOrgDetail
	currentHref: string
}) {
	const org = props.payload.org
	const data = props.payload
	return (
		<AccountManagementShell layout="detail" currentHref={props.currentHref}>
			<AdminPageHeader
				title={org.displayName || `@${org.slug}`}
				description={`@${org.slug} · ${org.kind === 'personal' ? 'Personal organization' : 'Team organization'}`}
				currentHref={props.currentHref}
			/>
			{data.softDelete ? (
				<AccountManagementMessage tone="error">
					This organization is deleted.{' '}
					{data.softDelete.deletedAt &&
					isWithinSoftDeleteRestoreWindow(data.softDelete.deletedAt) ? (
						<>
							Restorable until{' '}
							<TimestampValue value={data.softDelete.restoreDeadline} />.
						</>
					) : (
						'The restore window has passed.'
					)}
				</AccountManagementMessage>
			) : null}
			<AccountManagementPanel title="Overview">
				<MetadataGrid
					items={[
						{ label: 'Handle', value: `@${org.slug}` },
						{
							label: 'Kind',
							value: org.kind === 'personal' ? 'Personal' : 'Team',
						},
						{
							label: 'Created',
							value: <TimestampValue value={org.createdAt} />,
						},
						{
							label: 'Updated',
							value: <TimestampValue value={org.updatedAt} />,
						},
						{
							label: 'Suspended',
							value: <TimestampValue value={org.suspendedAt} fallback="No" />,
						},
						{ label: 'Teams', value: String(data.teamsCount) },
					]}
				/>
			</AccountManagementPanel>
			{data.softDelete ? (
				<AccountManagementPanel title="Deleted">
					<MetadataGrid
						items={[
							{
								label: 'Deleted',
								value: <TimestampValue value={data.softDelete.deletedAt} />,
							},
							{
								label: 'Deletion started',
								value: <TimestampValue value={data.softDelete.deletingAt} />,
							},
							{
								label: 'Restore deadline',
								value: (
									<TimestampValue value={data.softDelete.restoreDeadline} />
								),
							},
						]}
					/>
				</AccountManagementPanel>
			) : null}
			<AccountManagementPanel
				title="Plan"
				description="Plan changes move here in a follow-up."
			>
				<MetadataGrid
					items={[
						{ label: 'Manual grant', value: data.plan.manualPlan },
						{
							label: 'Stripe subscription',
							value: data.plan.stripePlan ?? 'None',
						},
						{ label: 'Effective plan', value: data.plan.effectivePlan },
						{
							label: 'Entitlement ladder',
							value: formatAdminEntitlementLadder(data.plan.entitlementLadder),
						},
						{
							label: 'Stripe customer',
							value: data.plan.stripeCustomerLinked ? 'Linked' : 'Not linked',
						},
						{
							label: 'Admin credits',
							value: data.plan.adminCreditsEligible
								? 'Eligible'
								: 'Not eligible',
						},
						{
							label: 'Stripe credits',
							value: data.plan.stripeCreditsEligible
								? 'Eligible'
								: 'Not eligible',
						},
						{
							label: 'Credits eligible',
							value: data.plan.creditsEligible ? 'Yes' : 'No',
						},
					]}
				/>
			</AccountManagementPanel>
			<AccountManagementPanel title="Seats & members">
				<p>
					{data.seats.live} {data.seats.live === 1 ? 'seat' : 'seats'} (owners
					and members) · {data.seats.billingOnly} billing-only{' '}
					{data.seats.billingOnly === 1 ? 'member' : 'members'}
				</p>
				<RecordTable
					mode="none"
					ariaLabel="Organization members"
					columns={[
						{ key: 'username', label: 'Username', primary: true },
						{ key: 'role', label: 'Role' },
						{ key: 'joined', label: 'Joined' },
						{ key: 'budget', label: 'Effective budget', align: 'end' },
						{ key: 'state', label: 'State' },
					]}
					rows={data.members.map((member) => ({
						id: member.stableUserId,
						href: adminMemberUserHref(member),
						cells: {
							username: member.username,
							role: formatAdminOrganizationRole(member.role),
							joined: <TimestampValue value={member.joinedAt} />,
							budget:
								member.effectiveBudgetMicroUsd == null
									? '—'
									: formatMicroUsd(member.effectiveBudgetMicroUsd),
							state: member.userDeletedAt
								? 'Deleted user'
								: member.membershipDeletedAt
									? 'Membership removed'
									: 'Live',
						},
					}))}
				/>
			</AccountManagementPanel>
			<AccountManagementPanel title="Budgets">
				<MetadataGrid
					items={[
						{
							label: 'Default user budget',
							value:
								data.budgets.defaultUserBudgetMicroUsd == null
									? 'None'
									: formatMicroUsd(data.budgets.defaultUserBudgetMicroUsd),
						},
						{
							label: 'Automation budget',
							value:
								data.budgets.automationBudgetMicroUsd == null
									? 'None'
									: formatMicroUsd(data.budgets.automationBudgetMicroUsd),
						},
					]}
				/>
				<RecordTable
					mode="none"
					ariaLabel="Per-user budget overrides"
					emptyLabel="No per-user budget overrides."
					columns={[
						{ key: 'username', label: 'Username', primary: true },
						{ key: 'budget', label: 'Individual budget', align: 'end' },
						{ key: 'effective', label: 'Effective budget', align: 'end' },
					]}
					rows={data.members
						.filter((member) => member.individualBudgetMicroUsd !== null)
						.map((member) => ({
							id: member.stableUserId,
							href: adminMemberUserHref(member),
							cells: {
								username: member.username,
								budget:
									member.individualBudgetMicroUsd == null
										? '—'
										: formatMicroUsd(member.individualBudgetMicroUsd),
								effective:
									member.effectiveBudgetMicroUsd == null
										? '—'
										: formatMicroUsd(member.effectiveBudgetMicroUsd),
							},
						}))}
				/>
			</AccountManagementPanel>
			<AccountManagementPanel title="Credits">
				<p>
					Balance: {formatMicroUsd(data.wallet.balanceMicroUsd)} ·{' '}
					{data.wallet.unlocked ? 'Unlocked' : 'Locked'}
				</p>
				<RecordTable
					mode="none"
					ariaLabel="Recent credit ledger"
					columns={[
						{ key: 'type', label: 'Type', primary: true },
						{ key: 'amount', label: 'Amount', align: 'end' },
						{ key: 'description', label: 'Description' },
						{ key: 'created', label: 'Created' },
						{ key: 'granter', label: 'Granted by' },
					]}
					rows={data.wallet.recent.map((item, index) => ({
						id: `${item.createdAt}-${index}`,
						cells: {
							type: formatAdminCreditLedgerKind(item.kind),
							amount: formatMicroUsd(item.amountMicroUsd),
							description: item.description,
							created: <TimestampValue value={item.createdAt} />,
							granter: item.grantedByUsername ?? '—',
						},
					}))}
				/>
			</AccountManagementPanel>
			{data.softDelete?.deletedAt ? (
				<AccountManagementPanel title="Limits">
					<p>Limit overrides are not available for a deleted organization.</p>
				</AccountManagementPanel>
			) : (
				<AdminOrgLimitsPanel orgId={org.id} />
			)}
		</AccountManagementShell>
	)
}

/** Deleted users only resolve on the users page with `status=deleted`. */
function adminMemberUserHref(member: {
	stableUserId: string
	userDeletedAt: string | null
}) {
	const href = `/admin/users/${encodeURIComponent(member.stableUserId)}`
	return member.userDeletedAt ? `${href}?status=deleted` : href
}
