/** @jsxImportSource @emotion/react */
import { connectSecretsInput } from '../connect-input.ts'
import { type ListDetailSelection } from '#client/list-detail-route.ts'
import {
	type ApprovalAction,
	getScopeLabel,
} from '#client/routes/account-approval-shared.ts'
import { getNewSecretValueAutofocusKey } from '#client/routes/new-secret-query.ts'
import { normalizeAllowedHosts } from '#client/routes/secret-normalization.ts'
import { toast } from '#client/toast.ts'
import {
	saveSecret,
	deleteSecret,
	approveSecretAccess,
	rejectSecretAccess,
} from '#start/server/account-mutations'
import { type AccountSecretsLoaderData } from '#universal/loader-data.ts'
import { fillPlacementViewFromDraft } from '#universal/credential-fill-placement.ts'
import { relocateAccountHref } from '#universal/org-pages.ts'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'
import { type CSSObject } from '@emotion/react'
import { buildAccountSecretPath } from '@kody-internal/shared/account-secret-route.ts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { Combobox, type ComboboxOption } from '../components/combobox.tsx'
import { secretMutationOptions } from '../secret-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { secretsSearch } from '../filter-search.ts'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import {
	isPackageSecretApprovalAlreadyGranted,
	renderAlreadyAddedNotice,
	renderPackageSecretApprovalPage,
	renderSecretApprovalCard,
} from './account-secrets-approval.tsx'
import { SecretEditor } from './account-secrets-editor.tsx'
import {
	type SecretFilterScope,
	applyStuckRenameRecovery,
	buildBaseSecretsHref,
	buildNewSecretHref,
	buildSecretHref,
	collectRepeatedTextRows,
	createEditorStateFromNewSecretQuery,
	createEditorStateFromSecret,
	createEmptyEditorState,
	filterSecrets,
	formatRelativeTtl,
	getAlreadyAddedNotice,
	getDataRefreshKey,
	readAccountSecretsSaveWarning,
	readFilterState,
	secretsBasePath,
} from './account-secrets-shared.ts'
import {
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	recordCellClamp,
	recordStampCss,
} from './record-table.tsx'

const clampedCellCss = recordCellClamp(26)

/**
 * A fixed measure that fits a package name beside the scope select on a wide
 * row. On a narrow container it takes a row of its own: sharing one with the
 * select squeezed both below their labels ("All sco…").
 */
const packageFilterSlotCss: CSSObject = {
	flex: '0 1 15rem',
	minWidth: '9rem',
	'@container (max-width: 620px)': { flex: '1 1 100%' },
}

export function AccountSecretsPage({
	payload,
	currentHref,
	selection,
	packageApproval,
}: {
	payload: AccountSecretsLoaderData
	currentHref: string
	selection: { selectedId: string | null; isCreating: boolean }
	packageApproval: boolean
}) {
	const packageOptions = payload.packageOptions
	const packagesById = new Map(
		payload.packages.map((pkg) => [
			pkg.id,
			{ kodyId: pkg.kodyId, name: pkg.name },
		]),
	)
	const secrets = payload.secrets
	const selectedSecret = payload.selectedSecret
	const approval = payload.approval
		? {
				...payload.approval,
				names: payload.approval.names.length
					? payload.approval.names
					: [payload.approval.name],
			}
		: null
	const [editorState, setEditorState] = useState(
		selection.isCreating
			? createEditorStateFromNewSecretQuery(payload.packageOptions, currentHref)
			: payload.selectedSecret
				? createEditorStateFromSecret(payload.selectedSecret)
				: createEmptyEditorState(payload.packageOptions),
	)
	const [savedEditorState, setSavedEditorState] = useState(editorState)
	const [message, setMessage] = useState<string | null>(
		readAccountSecretsSaveWarning(payload) ?? payload.approvalError ?? null,
	)
	const [submittingApprovalAction, setSubmittingApprovalAction] =
		useState<ApprovalAction | null>(null)
	const [completedPackageApproval, setCompletedPackageApproval] =
		useState<ApprovalAction | null>(null)
	const [packageApprovalHref, setPackageApprovalHref] = useState<string | null>(
		currentHref,
	)
	const [saveState, setSaveState] = useState<'idle' | 'saving' | 'deleting'>(
		'idle',
	)
	const [showSecretValue, setShowSecretValue] = useState(false)
	const queryClient = useQueryClient()
	const { actorKey, orgSlug, pageLocation } = useMatchedPageScope()
	const capture = useSubmitterScope()
	const save = useMutation(
		secretMutationOptions(
			queryClient,
			actorKey,
			orgSlug,
			mutationResources,
			saveSecret,
		),
	)
	const remove = useMutation(
		secretMutationOptions(
			queryClient,
			actorKey,
			orgSlug,
			mutationResources,
			deleteSecret,
		),
	)
	const approve = useMutation(
		secretMutationOptions(
			queryClient,
			actorKey,
			orgSlug,
			mutationResources,
			approveSecretAccess,
		),
	)
	const reject = useMutation(
		secretMutationOptions(
			queryClient,
			actorKey,
			orgSlug,
			mutationResources,
			rejectSecretAccess,
		),
	)
	const router = useRouter()
	const [deleteArmed, setDeleteArmed] = useState(false)
	const navigate = (href: string) =>
		void router.navigate({
			to: relocateAccountHref(href, currentHref),
			resetScroll: false,
		})

	function getCurrentHref() {
		return currentHref
	}

	function getCurrentSearch() {
		return new URL(getCurrentHref(), 'http://localhost').search
	}

	function buildHrefWithUpdatedFilters(
		nextFilters: Partial<ReturnType<typeof readFilterState>>,
		options?: { pathname?: string },
	) {
		const currentUrl = new URL(getCurrentHref(), 'http://localhost')
		const filters = {
			...readFilterState(pageLocation.search, packageOptions),
			...nextFilters,
		}
		return router.buildLocation({
			to: options?.pathname ?? currentUrl.pathname,
			search: {
				...pageLocation.search,
				q:
					nextFilters.search === undefined
						? secretsSearch(pageLocation.search).q
						: filters.search || undefined,
				scope: filters.scope === 'all' ? undefined : filters.scope,
				package: filters.packageId || undefined,
			},
		}).href
	}

	function updateFilters(next: Partial<ReturnType<typeof readFilterState>>) {
		const matchedUrl = new URL(currentHref, 'http://localhost')
		const samePage = router.latestLocation.pathname === matchedUrl.pathname
		return router.navigate({
			to: matchedUrl.pathname,
			replace: true,
			resetScroll: false,
			search: (previous: Record<string, unknown>) => {
				const search: Record<string, unknown> = samePage
					? { ...previous }
					: { ...pageLocation.search }
				if (next.search !== undefined) {
					if (next.search) search.q = next.search
					else delete search.q
				}
				if (next.scope !== undefined) {
					if (next.scope === 'all') delete search.scope
					else search.scope = next.scope
					if (next.scope === 'user') delete search.package
				}
				if (next.packageId !== undefined) {
					if (next.packageId) search.package = next.packageId
					else delete search.package
				}
				return search
			},
		})
	}

	function applyPayload(
		payload: AccountSecretsLoaderData,
		selection: ListDetailSelection,
		nextMessage: string | null,
		preserveDraft = false,
	) {
		setDeleteArmed(false)
		setShowSecretValue(false)
		if (!preserveDraft) {
			const freshEditor = selection.isCreating
				? createEditorStateFromNewSecretQuery(
						payload.packageOptions,
						currentHref,
					)
				: payload.selectedSecret
					? createEditorStateFromSecret(payload.selectedSecret)
					: createEmptyEditorState(payload.packageOptions)
			setEditorState(freshEditor)
			setSavedEditorState(freshEditor)
		}
		setMessage(
			readAccountSecretsSaveWarning(payload) ??
				nextMessage ??
				payload.approvalError ??
				(selection.selectedId && !payload.selectedSecret && !payload.approval
					? 'Secret not found.'
					: null),
		)
		setSubmittingApprovalAction(null)
		setSaveState('idle')
	}

	function formatAllowedPackageLabel(packageId: string) {
		const meta = packagesById.get(packageId)
		return meta
			? `${meta.kodyId} (${packageId})`
			: `Unknown package (${packageId})`
	}

	async function submitApproval(action: ApprovalAction) {
		if (!approval || submittingApprovalAction != null) return
		setSubmittingApprovalAction(action)
		setMessage(null)

		const isCurrent = capture()
		try {
			const currentUrl = new URL(getCurrentHref(), 'http://localhost')
			const requestUrl = new URL(currentUrl)
			requestUrl.search = currentUrl.search
			if (selection.selectedId) {
				requestUrl.searchParams.set('selected', selection.selectedId)
			}
			const input = {
				orgSlug: orgSlug ?? undefined,
				refresh: connectSecretsInput(requestUrl.search),
			}
			const outcome =
				action === 'approve'
					? await approve.mutateAsync(input)
					: await reject.mutateAsync(input)
			if (!isCurrent()) return
			save.reset()
			remove.reset()
			approve.reset()
			reject.reset()
			const isPackageApproval = Boolean(approval.requestedPackageId)
			setSubmittingApprovalAction(null)
			setMessage(
				isPackageApproval
					? null
					: outcome.action === 'approve'
						? 'Approved requested host.'
						: 'Rejected host approval request.',
			)
			if (isPackageApproval) {
				setCompletedPackageApproval(action)
				return
			}

			if (typeof window !== 'undefined' && window.location.search) {
				const nextHref = payload.selectedSecret
					? buildHrefWithUpdatedFilters(
							{},
							{
								pathname: buildAccountSecretPath({
									name: payload.selectedSecret.name,
									scope: payload.selectedSecret.scope,
									packageId: payload.selectedSecret.packageId,
								}),
							},
						)
					: buildHrefWithUpdatedFilters({}, { pathname: secretsBasePath })
				const nextUrl = new URL(nextHref, window.location.href)
				nextUrl.searchParams.delete('allowed-host')
				nextUrl.searchParams.delete('capability')
				nextUrl.searchParams.delete('package_id')
				nextUrl.searchParams.delete('package')
				nextUrl.searchParams.delete('names')
				nextUrl.searchParams.delete('name')
				// `navigate` is async (preload-then-commit); the commit render
				// consumes its preloaded data through `secretsData`.
				navigate(`${nextUrl.pathname}${nextUrl.search}`)
			}
		} catch (error) {
			if (!isCurrent()) return
			save.reset()
			remove.reset()
			approve.reset()
			reject.reset()
			setSubmittingApprovalAction(null)
			setMessage(
				error instanceof Error ? error.message : 'Unable to process approval.',
			)
		} finally {
			if (isCurrent()) {
				save.reset()
				remove.reset()
				approve.reset()
				reject.reset()
			}
		}
	}

	async function saveSecretChanges(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (saveState !== 'idle') return

		const form = event.currentTarget as HTMLFormElement
		const submittedEditorState = editorState

		setSaveState('saving')
		setMessage(null)

		const isCurrent = capture()
		try {
			const allowedHosts = normalizeAllowedHosts(
				collectRepeatedTextRows(form, 'allowed-hosts'),
			)
			const allowedPackages =
				submittedEditorState.scope === 'user'
					? [...submittedEditorState.allowedPackages].sort((left, right) =>
							left.localeCompare(right),
						)
					: []
			const placement = fillPlacementViewFromDraft(
				submittedEditorState.fillPlacement,
			)
			if (
				placement === null &&
				!(
					submittedEditorState.fillPlacement.headers &&
					submittedEditorState.fillPlacement.query &&
					submittedEditorState.fillPlacement.path &&
					submittedEditorState.fillPlacement.body
				)
			) {
				throw new Error('Choose at least one fill-placement part.')
			}
			const payload = await save.mutateAsync({
				orgSlug: orgSlug ?? undefined,
				fields: {
					currentId: submittedEditorState.currentId,
					name: submittedEditorState.name,
					scope: submittedEditorState.scope,
					packageId:
						submittedEditorState.scope === 'package'
							? submittedEditorState.packageId
							: null,
					description: submittedEditorState.description,
					expiresAt: submittedEditorState.expiresAt || null,
					value: submittedEditorState.value,
					allowedHosts,
					allowedPackages,
					placement,
				},
			})
			if (!isCurrent()) return
			save.reset()
			remove.reset()
			approve.reset()
			reject.reset()
			if (!payload.ok) {
				const recovered = applyStuckRenameRecovery({
					editor: submittedEditorState,
					stuck: payload.selectedSecret,
					search: getCurrentSearch(),
				})
				setEditorState(recovered.editor)
				setSaveState('idle')
				toast.error(payload.error)
				navigate(recovered.href)
				return
			}

			const warning = readAccountSecretsSaveWarning(payload)
			if (warning) toast.error(warning)
			const wasCreating = !submittedEditorState.currentId
			const savedEditor = createEditorStateFromSecret(payload.selectedSecret)
			setEditorState(savedEditor)
			setSavedEditorState(savedEditor)
			setShowSecretValue(false)
			setDeleteArmed(false)
			setSaveState('idle')
			setMessage(warning ?? (wasCreating ? 'Created secret.' : 'Saved secret.'))

			if (payload.selectedSecret) {
				navigate(
					buildSecretHref(
						payload.selectedSecret,
						wasCreating ? '' : getCurrentSearch(),
					),
				)
			}
		} catch (error) {
			if (!isCurrent()) return
			save.reset()
			remove.reset()
			approve.reset()
			reject.reset()
			setSaveState('idle')
			setMessage(
				error instanceof Error ? error.message : 'Unable to save secret.',
			)
		} finally {
			if (isCurrent()) {
				save.reset()
				remove.reset()
				approve.reset()
				reject.reset()
			}
		}
	}

	async function deleteSelectedSecret() {
		if (!editorState.currentId || saveState !== 'idle') return

		setSaveState('deleting')
		setMessage(null)

		const isCurrent = capture()
		try {
			await remove.mutateAsync({
				orgSlug: orgSlug ?? undefined,
				fields: {
					currentId: editorState.currentId,
				},
			})
			if (!isCurrent()) return
			save.reset()
			remove.reset()
			approve.reset()
			reject.reset()

			navigate(buildBaseSecretsHref(getCurrentSearch()))
		} catch (error) {
			if (!isCurrent()) return
			save.reset()
			remove.reset()
			approve.reset()
			reject.reset()
			setSaveState('idle')
			setMessage(
				error instanceof Error ? error.message : 'Unable to delete secret.',
			)
		} finally {
			if (isCurrent()) {
				save.reset()
				remove.reset()
				approve.reset()
				reject.reset()
			}
		}
	}

	function updateAllowedHost(index: number, value: string) {
		setEditorState({
			...editorState,
			allowedHosts: editorState.allowedHosts.map((host, hostIndex) =>
				hostIndex === index ? value : host,
			),
		})
	}

	function addAllowedHost() {
		setEditorState({
			...editorState,
			allowedHosts: [...editorState.allowedHosts, ''],
		})
	}

	function removeAllowedHost(index: number) {
		const nextHosts = editorState.allowedHosts.filter(
			(_host, hostIndex) => hostIndex !== index,
		)
		setEditorState({
			...editorState,
			allowedHosts: nextHosts.length > 0 ? nextHosts : [''],
		})
	}

	function addAllowedPackage(packageId: string) {
		if (editorState.allowedPackages.includes(packageId)) return
		setEditorState({
			...editorState,
			allowedPackages: [...editorState.allowedPackages, packageId],
		})
	}

	function removeAllowedPackage(packageId: string) {
		setEditorState({
			...editorState,
			allowedPackages: editorState.allowedPackages.filter(
				(candidate) => candidate !== packageId,
			),
		})
	}

	const isRefreshingForLocationChange = false
	const [lastPayload, setLastPayload] = useState(payload)
	const dataKey = getDataRefreshKey(currentHref)
	const [lastLocation, setLastLocation] = useState(dataKey)
	if (
		(lastPayload !== payload || lastLocation !== dataKey) &&
		saveState === 'idle' &&
		submittingApprovalAction === null
	) {
		setLastPayload(payload)
		setLastLocation(dataKey)
		applyPayload(
			payload,
			selection,
			null,
			lastLocation === dataKey &&
				JSON.stringify(editorState) !== JSON.stringify(savedEditorState),
		)
	}

	const filters = readFilterState(pageLocation.search, packageOptions)
	const filteredSecrets = filterSecrets(secrets, filters, packagesById)
	const packageSelectOptions: Array<ComboboxOption> = packageOptions.map(
		(packageOption) => {
			const metadata = packagesById.get(packageOption.id)
			return {
				id: packageOption.id,
				label: metadata?.kodyId ?? packageOption.title,
				keywords: [packageOption.id],
			}
		},
	)
	const availableAllowedPackageOptions = packageSelectOptions.filter(
		(option) => !editorState.allowedPackages.includes(option.id),
	)
	const filterPackageOptions: Array<ComboboxOption> = [
		{ id: '', label: 'All packages' },
		...packageSelectOptions,
	]

	const activeSecretId = selection.selectedId ?? selectedSecret?.id ?? null
	const isMutating = saveState !== 'idle' || submittingApprovalAction != null
	const canCreatePackageSecrets = packageOptions.length > 0
	const showEditor = selection.isCreating || selectedSecret != null
	const secretValueAutofocusKey = getNewSecretValueAutofocusKey(currentHref)
	if (packageApprovalHref !== currentHref) {
		setPackageApprovalHref(currentHref)
		setCompletedPackageApproval(null)
	}

	if (packageApproval) {
		const approvalError = payload.approvalError ?? null
		const pageApprovalError = approvalError
		const alreadyGranted =
			approval != null &&
			completedPackageApproval !== 'reject' &&
			isPackageSecretApprovalAlreadyGranted({
				secrets,
				approval,
			})
		return renderPackageSecretApprovalPage({
			currentHref,
			approval,
			approvalError: pageApprovalError,
			packagesById,
			completed: completedPackageApproval,
			alreadyGranted,
			submittingAction: submittingApprovalAction,
			message: message && message !== pageApprovalError ? message : null,
			onSubmit: (action) => {
				void submitApproval(action)
			},
		})
	}

	const alreadyAddedNotice = getAlreadyAddedNotice({
		href: currentHref,
		selectedSecret,
		approval,
		formatPackageId: formatAllowedPackageLabel,
	})
	const approvalCard =
		approval &&
		!isRefreshingForLocationChange &&
		!alreadyAddedNotice?.hostAlreadyAdded &&
		!alreadyAddedNotice?.packageAlreadyAdded
			? approval
			: null
	return (
		<AccountManagementShell currentHref={currentHref} busy={false}>
			<AccountPageHeader
				entity="secrets"
				title="Secrets"
				description="Passwords and tokens Kody can use for you."
				currentHref={currentHref}
				actions={
					<button
						type="button"
						disabled={isMutating}
						onClick={() => {
							if (isMutating) return
							navigate(buildNewSecretHref(getCurrentSearch()))
						}}
						css={primaryButtonCss}
					>
						New secret
					</button>
				}
			/>

			{approvalCard
				? renderSecretApprovalCard({
						approvalCard,
						packagesById,
						disabled: isMutating || isRefreshingForLocationChange,
						onSubmit: (action) => void submitApproval(action),
					})
				: null}
			{alreadyAddedNotice
				? renderAlreadyAddedNotice(alreadyAddedNotice.items)
				: null}

			{message ? (
				<AccountManagementMessage tone={'info'}>
					{message}
				</AccountManagementMessage>
			) : null}

			<RecordTable
				mode="expand"
				ariaLabel="Saved secrets"
				selectedId={activeSecretId}
				recordLoading={Boolean(
					selection.selectedId &&
					!selection.isCreating &&
					selectedSecret == null &&
					isRefreshingForLocationChange,
				)}
				countLabel={`${filteredSecrets.length} of ${secrets.length} shown`}
				emptyLabel={
					secrets.length === 0
						? 'No secrets yet. Create one to get started.'
						: 'No secrets match the current filters.'
				}
				toolbar={
					<>
						<RecordTableSearch
							label="Search secrets"
							placeholder="Search secrets"
							value={secretsSearch(pageLocation.search).q ?? ''}
							onInput={(value) => {
								return updateFilters({ search: value })
							}}
						/>
						<RecordTableSelect
							label="Filter secrets by scope"
							value={filters.scope}
							onChange={(value) => {
								const nextScope = value as SecretFilterScope
								updateFilters({ scope: nextScope })
							}}
						>
							<option value="all">All scopes</option>
							<option value="user">User</option>
							<option value="package">Package</option>
						</RecordTableSelect>
						{packageOptions.length > 0 ? (
							<span css={packageFilterSlotCss}>
								<Combobox
									key={`secret-package-filter:${filters.packageId}`}
									id="secret-package-filter"
									label="Filter secrets by package"
									hideLabel
									placeholder="All packages"
									value={filters.scope === 'user' ? '' : filters.packageId}
									disabled={filters.scope === 'user'}
									options={filterPackageOptions}
									onChange={(packageId) => {
										updateFilters({ packageId })
									}}
								/>
							</span>
						) : null}
					</>
				}
				columns={[
					{ key: 'name', label: 'Secret', primary: true },
					{ key: 'scope', label: 'Scope' },
					{ key: 'package', label: 'Package', drop: 2 },
					{ key: 'description', label: 'Description', drop: 1 },
					{ key: 'ttl', label: 'Expires' },
				]}
				createRow={
					selection.isCreating
						? {
								href: isMutating
									? undefined
									: buildNewSecretHref(getCurrentSearch()),
								label: 'New secret',
							}
						: undefined
				}
				rows={filteredSecrets.map((secret) => ({
					id: secret.id,
					// A save or delete is in flight; the expanded editor owns
					// the selection until it settles.
					href: isMutating
						? undefined
						: relocateAccountHref(
								buildSecretHref(secret, getCurrentSearch()),
								currentHref,
							),
					cells: {
						name: <span css={clampedCellCss}>{secret.name}</span>,
						scope: getScopeLabel(secret.scope),
						package: (
							<span css={clampedCellCss}>{secret.packageTitle || '—'}</span>
						),
						description: (
							<span css={clampedCellCss}>{secret.description || '—'}</span>
						),
						ttl: (
							<span css={recordStampCss}>
								{formatRelativeTtl(secret.ttlMs)}
							</span>
						),
					},
				}))}
				record={
					showEditor ? (
						<SecretEditor
							{...{
								isCreating: selection.isCreating,
								selectedSecret,
								editorState,
								setEditorState: (next) => {
									setEditorState(next)
								},
								packageOptions,
								packageSelectOptions,
								availableAllowedPackageOptions,
								packagesById,
								canCreatePackageSecrets,
								isMutating,
								saveState,
								showSecretValue,
								onToggleShowSecretValue: () => {
									setShowSecretValue(!showSecretValue)
								},
								secretValueAutofocusKey,
								deleteArmed,
								onDeleteArm: () => setDeleteArmed(true),
								onDeleteReset: () => setDeleteArmed(false),
								onSave: saveSecretChanges,
								onDelete: () => void deleteSelectedSecret(),
								updateAllowedHost,
								addAllowedHost,
								removeAllowedHost,
								addAllowedPackage,
								removeAllowedPackage,
							}}
						/>
					) : null
				}
			/>
		</AccountManagementShell>
	)
}

const primaryButtonCss = getPillButtonCss({ size: 'sm' })

const mutationResources = [
	'loadSecretsPage',
	'loadOnboarding',
	'loadAccountPage',
	'loadUsagePage',
] as const
