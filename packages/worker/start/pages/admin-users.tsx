/** @jsxImportSource @emotion/react */
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { isAdminUserVerificationFilter } from '#universal/email-verification-delivery.ts'
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from '@tanstack/react-query'
import { useRouteContext, useRouter } from '@tanstack/react-router'
import {
	type FormEvent,
	useEffect,
	useEffectEvent,
	useRef,
	useState,
} from 'react'
import { adminUsersFilters, adminUsersSearch } from '../admin-users-input.ts'
import { usePageInvalidation } from '../page-invalidation.ts'

import {
	type AdminUserFilterState,
	buildUserDetailHrefFrom,
} from '#client/routes/admin-users-shared.ts'
import {
	readAdminUsersPage,
	readAdminUserUsage,
} from '#start/server/admin-controls'
import {
	assignAdminUserRole,
	removeAdminUserRole,
	setAdminUserPlan,
	suspendAdminUser,
	unsuspendAdminUser,
	resumeAdminUserEmail,
	verifyAdminUserEmail,
	mintAdminUserVerificationUrl,
	createAdminUser,
} from '#start/server/admin-mutations'
import {
	type AdminCreatedUserSetup,
	type AdminPlanName,
	type AdminUsersLoaderData,
} from '#universal/loader-data.ts'
import { type RoleName } from '#universal/permissions.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AdminPageHeader,
} from './account-management-components.tsx'
import { AdminCreateUserPanel } from './admin-users-create.tsx'
import {
	type AdminUsersActionState,
	AdminUserDetail,
} from './admin-users-detail.tsx'
import {
	recordCellClamp,
	RecordChips,
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
} from './record-table.tsx'
const clampedCellCss = recordCellClamp(28)
type UsageStatus = 'loading' | 'ready' | 'error'
export function AdminUsersPage(props: {
	payload: AdminUsersLoaderData
	currentHref: string
	selectedStableUserId: string | null
}) {
	const invalidatePages = usePageInvalidation(mutationResources)
	const invalidateOwnPermissions = usePageInvalidation('permissions', {
		refreshShell: true,
	})
	const { actorKey } = useRouteContext({ from: '__root__' })
	const router = useRouter()
	const { pageLocation } = useMatchedPageScope()
	const client = useQueryClient()
	const activeScope = useRef<object | null>(null)
	useEffect(() => {
		const scope = {}
		activeScope.current = scope
		return () => {
			if (activeScope.current === scope) activeScope.current = null
		}
	}, [actorKey, props.currentHref])
	const sentinelRef = useRef<HTMLDivElement | null>(null)
	const availableRoles = props.payload.availableRoles
	const availablePlans = props.payload.availablePlans
	const selectedUserFallback = props.payload.selectedUser
	const [loadAdditionalPages, setLoadAdditionalPages] = useState(false)
	const listFilters = adminUsersFilters(pageLocation.search)
	const additional = useInfiniteQuery({
		queryKey: ['admin-users-pages', actorKey, listFilters],
		initialPageParam: props.payload.page + 1,
		enabled:
			loadAdditionalPages &&
			props.payload.page * props.payload.pageSize < props.payload.total,
		queryFn: ({ pageParam, signal }) =>
			readAdminUsersPage({
				data: {
					...listFilters,
					page: pageParam,
				},
				signal,
			}),
		getNextPageParam: (last) =>
			last.page * last.pageSize < last.total ? last.page + 1 : undefined,
	})
	const userMap = new Map(
		props.payload.users.map((user) => [user.stableUserId, user]),
	)
	for (const page of additional.data?.pages ?? [])
		for (const user of page.users)
			if (!userMap.has(user.stableUserId)) userMap.set(user.stableUserId, user)
	const usersSnapshot = {
		items: [...userMap.values()],
		hasMore: additional.data
			? additional.hasNextPage
			: props.payload.page * props.payload.pageSize < props.payload.total,
		totalCount: props.payload.total,
		isLoadingMore: additional.isFetching,
		error: additional.error?.message ?? null,
	}
	const write = useMutation({
		mutationFn: async (input: {
			perform: () =>
				| ReturnType<typeof createAdminUser>
				| ReturnType<typeof mintAdminUserVerificationUrl>
				| ReturnType<typeof assignAdminUserRole>
			actorKey: string | null
			target: string | null
			permissions: boolean
		}) => input.perform(),
		onMutate: (input) => ({
			reconcile: input.permissions ? invalidateOwnPermissions : invalidatePages,
		}),
		onSettled: async (_data, _error, input, snapshot) => {
			await Promise.all([
				snapshot?.reconcile(),
				client.invalidateQueries({
					queryKey: ['admin-users-pages', input.actorKey],
				}),
				client.invalidateQueries({
					queryKey: [
						'admin-user',
						input.actorKey,
						...(input.target ? [input.target] : []),
					],
				}),
			])
		},
		gcTime: 0,
	})
	function submitUserChange(
		target: string | null,
		perform: () =>
			| ReturnType<typeof createAdminUser>
			| ReturnType<typeof mintAdminUserVerificationUrl>
			| ReturnType<typeof assignAdminUserRole>,
	) {
		return write.mutateAsync({
			perform,
			actorKey,
			target,
			permissions: target === actorKey,
		})
	}

	const [message, setMessage] = useState<string | null>(null)
	const [actionState, setActionState] = useState<AdminUsersActionState>('idle')
	const [createdUser, setCreatedUser] = useState<AdminCreatedUserSetup | null>(
		null,
	)
	const [mintedVerifyUrl, setMintedVerifyUrl] = useState<string | null>(null)
	const [mintedVerifyUrlForStableUserId, setMintedVerifyUrlForStableUserId] =
		useState<string | null>(null)
	const [selectedRoleToAssign, setSelectedRoleToAssign] = useState(
		'user' as RoleName,
		// Draft follows the selected user (see the render body) until the admin
		// edits it. Null stored plan values are shown/saved as `free`.
	)
	const [planDraftChoice, setSelectedPlanChoice] =
		useState<AdminPlanName>('free')
	const [planDraftStableUserId, setPlanDraftStableUserId] = useState<
		string | null
	>(null)
	function getCurrentHref() {
		return props.currentHref
	}
	function resolveSelectedUser() {
		const selectedStableUserId = props.selectedStableUserId
		if (selectedStableUserId == null) return null
		return (
			usersSnapshot.items.find(
				(user) => user.stableUserId === selectedStableUserId,
			) ??
			(selectedUserFallback?.stableUserId === selectedStableUserId
				? selectedUserFallback
				: null)
		)
	}

	function updateFilters(next: Partial<AdminUserFilterState>) {
		const matchedUrl = pageLocation
		const pathname: string = matchedUrl.pathname
		const samePage = router.latestLocation.pathname === matchedUrl.pathname
		return router.navigate({
			to: pathname,
			replace: true,
			search: (previous: Record<string, unknown>) => {
				const search: Record<string, unknown> = samePage
					? { ...previous }
					: { ...pageLocation.search }
				for (const [filter, key] of [
					['search', 'q'],
					['role', 'role'],
					['verification', 'verification'],
				] as const) {
					const value = next[filter]
					if (value === undefined) continue
					if (value) search[key] = value
					else delete search[key]
				}
				delete search.page
				return search
			},
		})
	}

	function buildUserDetailHref(stableUserId: string) {
		return buildUserDetailHrefFrom(getCurrentHref(), stableUserId)
	}
	function invalidateUsage() {
		void client.invalidateQueries({ queryKey: ['admin-user', actorKey] })
	}
	function resetPlanDraft() {
		setPlanDraftStableUserId(null)
	}
	async function loadMoreUsers() {
		if (additional.isFetching || !usersSnapshot.hasMore) return false
		if (!loadAdditionalPages) setLoadAdditionalPages(true)
		else await additional.fetchNextPage()
		return true
	}
	async function submitRoleAction(action: 'assign_role' | 'remove_role') {
		const submittedScope = activeScope.current
		const selectedUser = resolveSelectedUser()
		if (!selectedUser || actionState !== 'idle') return
		setActionState(action === 'assign_role' ? 'assigning' : 'removing')
		setMessage(null)
		try {
			await submitUserChange(selectedUser.stableUserId, () =>
				(action === 'assign_role' ? assignAdminUserRole : removeAdminUserRole)({
					data: {
						stableUserId: selectedUser.stableUserId,
						role: selectedRoleToAssign,
					},
				}),
			)
			if (activeScope.current !== submittedScope) return
			resetPlanDraft()
			setMessage(
				action === 'assign_role'
					? `Assigned ${selectedRoleToAssign} role.`
					: `Removed ${selectedRoleToAssign} role.`,
			)
			setActionState('idle')
		} catch (error) {
			if (activeScope.current !== submittedScope) return
			setActionState('idle')
			setMessage(
				error instanceof Error ? error.message : 'Unable to update user roles.',
			)
		}
	}
	async function submitPlanAction() {
		const submittedScope = activeScope.current
		const selectedUser = resolveSelectedUser()
		if (!selectedUser || actionState !== 'idle') return
		const plan =
			selectedUser.stableUserId === planDraftStableUserId
				? planDraftChoice
				: (selectedUser.plan ?? 'free')
		setActionState('saving-plan')
		setMessage(null)
		try {
			await submitUserChange(selectedUser.stableUserId, () =>
				setAdminUserPlan({
					data: { stableUserId: selectedUser.stableUserId, plan },
				}),
			)
			if (activeScope.current !== submittedScope) return
			resetPlanDraft()
			invalidateUsage()
			setMessage(`Updated admin grant to ${plan}.`)
			setActionState('idle')
		} catch (error) {
			if (activeScope.current !== submittedScope) return
			setActionState('idle')
			setMessage(
				error instanceof Error ? error.message : 'Unable to update user plan.',
			)
		}
	}
	async function submitVerificationAction(
		action: 'mark_email_verified' | 'mint_verify_url',
	) {
		const submittedScope = activeScope.current
		const selectedUser = resolveSelectedUser()
		if (!selectedUser || actionState !== 'idle') return
		setActionState('verifying')
		setMessage(null)
		try {
			const payload = await submitUserChange(selectedUser.stableUserId, () =>
				(action === 'mint_verify_url'
					? mintAdminUserVerificationUrl
					: verifyAdminUserEmail)({
					data: { stableUserId: selectedUser.stableUserId },
				}),
			)
			if (activeScope.current !== submittedScope) return
			resetPlanDraft()
			if (
				action === 'mint_verify_url' &&
				'verifyUrl' in payload &&
				payload.verifyUrl
			) {
				setMintedVerifyUrl(payload.verifyUrl)
				setMintedVerifyUrlForStableUserId(selectedUser.stableUserId)
				setMessage(
					'Minted a one-time verify link. Send it over a path that is not kody.codes.',
				)
			} else {
				setMintedVerifyUrl(null)
				setMintedVerifyUrlForStableUserId(null)
				setMessage('Marked email verified.')
			}
			setActionState('idle')
		} catch (error) {
			if (activeScope.current !== submittedScope) return
			setActionState('idle')
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to update verification.',
			)
		}
	}
	async function submitModerationAction(
		action: 'suspend_user' | 'unsuspend_user' | 'resume_email_outbound',
	) {
		const submittedScope = activeScope.current
		const selectedUser = resolveSelectedUser()
		if (!selectedUser || actionState !== 'idle') return
		setActionState('moderating')
		setMessage(null)
		try {
			await submitUserChange(selectedUser.stableUserId, () =>
				(action === 'suspend_user'
					? suspendAdminUser
					: action === 'unsuspend_user'
						? unsuspendAdminUser
						: resumeAdminUserEmail)({
					data: { stableUserId: selectedUser.stableUserId },
				}),
			)
			if (activeScope.current !== submittedScope) return
			resetPlanDraft()
			setMessage(
				action === 'suspend_user'
					? 'Account suspended.'
					: action === 'unsuspend_user'
						? 'Account suspension cleared.'
						: 'Outbound email resumed.',
			)
			setActionState('idle')
		} catch (error) {
			if (activeScope.current !== submittedScope) return
			setActionState('idle')
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to update the account.',
			)
		}
	}
	async function submitCreateUser(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		if (actionState !== 'idle') return
		const form = event.currentTarget
		const formData = new FormData(form)
		const submittedScope = activeScope.current
		setActionState('creatingUser')
		setCreatedUser(null)
		setMessage(null)
		try {
			const payload = await submitUserChange(null, () =>
				createAdminUser({
					data: {
						email: String(formData.get('email') ?? '').trim(),
						username: String(formData.get('username') ?? '').trim(),
					},
				}),
			)
			if (activeScope.current !== submittedScope) return
			resetPlanDraft()
			setCreatedUser(
				'createdUser' in payload ? payload.createdUser : createdUser,
			)
			setMessage('User created. Copy the setup link below.')
			setActionState('idle')
			if ('createdUser' in payload && payload.createdUser) form.reset()
		} catch (error) {
			if (activeScope.current !== submittedScope) return
			setActionState('idle')
			setMessage(
				error instanceof Error ? error.message : 'Unable to create user.',
			)
		}
	}
	const loadMoreFromIntersection = useEffectEvent(loadMoreUsers)
	useEffect(() => {
		const node = sentinelRef.current
		if (!node) return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting))
					void loadMoreFromIntersection()
			},
			{ rootMargin: '400px' },
		)
		observer.observe(node)
		return () => observer.disconnect()
	}, [
		usersSnapshot.items.length,
		usersSnapshot.hasMore,
		usersSnapshot.isLoadingMore,
	])
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const currentHref = props.currentHref
	const pending = false

	const { items: users, hasMore, totalCount, isLoadingMore } = usersSnapshot
	const filters: AdminUserFilterState = {
		search: listFilters.query,
		role: listFilters.role,
		verification: isAdminUserVerificationFilter(listFilters.verification)
			? listFilters.verification
			: '',
	}
	const hasActiveFilters = Boolean(
		filters.search || filters.role || filters.verification,
	)
	const selectedStableUserId = props.selectedStableUserId
	const selectedUser = resolveSelectedUser()
	const isMutating = actionState !== 'idle'
	const selectedUsageId = selectedUser?.stableUserId ?? null
	const usageQuery = useQuery({
		meta: { actorKey },
		queryKey: ['admin-user', actorKey, selectedUsageId, 'usage'],
		enabled: selectedUsageId !== null,
		queryFn: ({ signal }) =>
			readAdminUserUsage({ data: { stableUserId: selectedUsageId! }, signal }),
	})
	const usageData = usageQuery.data
	const usageStatus: UsageStatus = usageQuery.isPending
		? 'loading'
		: usageQuery.isError
			? 'error'
			: 'ready'
	const usageMessage = usageQuery.error?.message ?? null
	const usageFailedForStableUserId = usageQuery.isError ? selectedUsageId : null

	// Never render one account's usage under another account's header
	// while the drill-down request is still in flight.
	const selectedUsage =
		selectedUser &&
		usageData &&
		usageData.stableUserId === selectedUser.stableUserId
			? usageData
			: null
	const selectedPlanChoice =
		selectedUser?.stableUserId === planDraftStableUserId
			? planDraftChoice
			: (selectedUser?.plan ?? 'free')

	return (
		<AccountManagementShell currentHref={currentHref} busy={pending}>
			<AdminPageHeader
				title="Admin users"
				description="Review account metadata and manage role assignments and entitlement plans. User content is never shown here."
				currentHref={currentHref}
			/>
			{message ? (
				<AccountManagementMessage tone="info">
					{message}
				</AccountManagementMessage>
			) : null}
			{usersSnapshot.error ? (
				<AccountManagementMessage tone="error">
					{usersSnapshot.error}
				</AccountManagementMessage>
			) : null}
			{
				<AdminCreateUserPanel
					{...{
						actionState,
						createdUser,
						isMutating,
						onSubmit: submitCreateUser,
					}}
				/>
			}
			<RecordTable
				mode="expand"
				busy={pending}
				ariaLabel="User accounts"
				selectedId={selectedStableUserId}
				// Unconditional: the snapshot keeps the previous window during a
				// refetch, and dropping the slot mid-refetch resized the search
				// field the reader is typing into.
				countLabel={`${users.length} of ${totalCount} ${totalCount === 1 ? 'account' : 'accounts'}`}
				emptyLabel={
					hasActiveFilters
						? 'No users match the current filters.'
						: 'No users found.'
				}
				toolbar={
					<>
						<RecordTableSearch
							label="Search users"
							placeholder="Search by username or email"
							value={adminUsersSearch(pageLocation.search).q ?? ''}
							onInput={(value) => {
								return updateFilters({ search: value })
							}}
						/>
						<RecordTableSelect
							label="Filter users by role"
							value={filters.role}
							onChange={(value) => {
								updateFilters({ role: value })
							}}
						>
							<option value="">All roles</option>
							{availableRoles.map((role) => (
								<option key={role} value={role}>
									{role}
								</option>
							))}
						</RecordTableSelect>
						<RecordTableSelect
							label="Filter users by verification"
							value={filters.verification}
							onChange={(value) => {
								updateFilters({
									verification: value === 'stalled' ? 'stalled' : '',
								})
							}}
						>
							<option value="">All verification</option>
							<option value="stalled">Stalled accepted</option>
						</RecordTableSelect>
					</>
				}
				columns={[
					{ key: 'username', label: 'Username', primary: true },
					{ key: 'email', label: 'Email', drop: 1 },
					{ key: 'roles', label: 'Roles', drop: 2 },
				]}
				rows={users.map((user) => ({
					id: user.stableUserId,
					// A role or plan mutation is in flight against the selected
					// user; navigating away mid-write would strand it.
					href: isMutating ? undefined : buildUserDetailHref(user.stableUserId),
					cells: {
						username: user.username,
						email: <span css={clampedCellCss}>{user.email}</span>,
						roles: <RecordChips items={user.roles} empty="No roles" />,
					},
				}))}
				footer={
					hasMore ? (
						<div ref={sentinelRef}>
							<button
								type="button"
								disabled={isLoadingMore}
								onClick={() => void loadMoreUsers()}
								css={{ ...secondaryButtonCss, width: '100%' }}
							>
								{isLoadingMore ? 'Loading more…' : 'Load more'}
							</button>
						</div>
					) : null
				}
				record={
					selectedUser ? (
						<AdminUserDetail
							key={selectedUser.stableUserId}
							{...{
								selectedUser,
								availableRoles,
								availablePlans,
								actionState,
								selectedRoleToAssign,
								selectedPlanChoice,
								mintedVerifyUrl,
								mintedVerifyUrlForStableUserId,
								usageStatus:
									selectedUsage ||
									usageFailedForStableUserId === selectedUsageId
										? usageStatus
										: 'loading',
								usageMessage,
								usageFailedForStableUserId,
								selectedUsage,
								onRoleToAssignChange: (role) => {
									setSelectedRoleToAssign(role)
								},
								onSubmitRoleAction: (action) => void submitRoleAction(action),
								onSubmitVerificationAction: (action) =>
									void submitVerificationAction(action),
								onPlanChoiceChange: (plan) => {
									setPlanDraftStableUserId(selectedUser.stableUserId)
									setSelectedPlanChoice(plan)
								},
								onSubmitPlanAction: () => void submitPlanAction(),
								onCreditsGranted: invalidateUsage,
								onSubmitModerationAction: (action) =>
									void submitModerationAction(action),
							}}
						/>
					) : null
				}
			/>
		</AccountManagementShell>
	)
}

const mutationResources = [
	'loadAdminUsers',
	'loadAdminRoles',
	'loadAdminInsights',
	'loadAccountPage',
	'loadProfile',
	'loadUsagePage',
	'loadBillingPage',
] as const
