/** @jsxImportSource @emotion/react */
import { textSearch } from '../filter-search.ts'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { type PlatformIntegrationSaveInput } from '#universal/admin-provider-mutations.ts'
import {
	filterApps,
	parseExtraAuthorizeParams,
	platformIntegrationsRoute,
	splitListInput,
	type ActionState,
} from '#client/routes/admin-platform-integrations-shared.ts'
import {
	saveAdminPlatformIntegration,
	deleteAdminPlatformIntegration,
} from '#start/server/admin-mutations'
import {
	type AdminPlatformIntegrationApp,
	type AdminPlatformIntegrationsLoaderData,
} from '#universal/loader-data.ts'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { css } from '@emotion/react'
import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'
import { useRouter } from '@tanstack/react-router'
import {
	useEffect,
	useRef,
	useState,
	type ChangeEvent,
	type FormEvent,
} from 'react'
import { formatTimestampDate } from '../components/local-timestamp.tsx'
import { useMutation } from '@tanstack/react-query'
import { usePageInvalidation } from '../page-invalidation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AdminPageHeader,
} from './account-management-components.tsx'
import { IntegrationForm } from './admin-platform-integrations-form.tsx'
import {
	RecordDot,
	RecordTable,
	RecordTableSearch,
	recordCellClamp,
	recordStampCss,
} from './record-table.tsx'
const clampedCellCss = css(recordCellClamp(28))
export function AdminPlatformIntegrationsPage(props: {
	payload: AdminPlatformIntegrationsLoaderData
	currentHref: string
	selection: { selectedId: string | null; isCreating: boolean }
}) {
	const { apps } = props.payload
	const { pageLocation } = useMatchedPageScope()
	const captureSubmitter = useSubmitterScope()
	const invalidate = usePageInvalidation(mutationResources)
	const saveMutation = useMutation({
		gcTime: 0,
		mutationFn: saveAdminPlatformIntegration,
		onMutate: () => invalidate,
		onSettled: (_data, _error, _input, reconcile) => reconcile?.(),
	})
	const removeMutation = useMutation({
		gcTime: 0,
		mutationFn: deleteAdminPlatformIntegration,
		onMutate: () => invalidate,
		onSettled: (_data, _error, _input, reconcile) => reconcile?.(),
	})
	const router = useRouter()
	function updateSearch(q: string) {
		const pathname: string = pageLocation.pathname
		const samePage = router.latestLocation.pathname === pageLocation.pathname
		return router.navigate({
			to: pathname,
			replace: true,
			resetScroll: false,
			search: (previous: Record<string, unknown>) => {
				const search: Record<string, unknown> = samePage
					? previous
					: pageLocation.search
				return { ...search, q: q || undefined }
			},
		})
	}
	const replaceLocation = (href: string) =>
		router.navigate({ href, replace: true })
	const lifetime = useRef<AbortController | null>(null)
	const readerRef = useRef<FileReader | null>(null)
	useEffect(() => {
		const controller = new AbortController()
		lifetime.current = controller
		return () => {
			controller.abort()
			readerRef.current?.abort()
		}
	}, [])
	const [message, setMessage] = useState<string | null>(null)
	const [messageTone, setMessageTone] = useState<'info' | 'error'>('info')
	const [requestedAction, setRequestedAction] = useState<ActionState>(
		'idle',
		/** Slug of the row an action is running against, for per-row labels. */
	)
	const actionState =
		saveMutation.isPending || removeMutation.isPending
			? requestedAction
			: 'idle'
	const [pendingSlug, setPendingSlug] = useState<string | null>(null)
	const [pendingLogoBase64, setPendingLogoBase64] = useState<
		string | undefined
	>(undefined)
	const [removeLogoChecked, setRemoveLogoChecked] = useState(
		false,
		/** Bumped after a successful edit save so uncontrolled fields remount. */
	)
	const [formRevision, setFormRevision] = useState(0)
	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	function applyData() {
		setMessage(null)
		setMessageTone('info')
	}
	function resetFormState() {
		setPendingLogoBase64(undefined)
		setRemoveLogoChecked(false)
	}
	function resetSelectionState() {
		resetFormState()
		setMessage(null)
		setMessageTone('info')
	}
	async function submitAdminAction(
		submit: () => Promise<unknown>,
		nextActionState: Exclude<ActionState, 'idle'>,
		successMessage: string,
		slug: string,
	): Promise<boolean> {
		const isCurrent = captureSubmitter()
		setRequestedAction(nextActionState)
		setPendingSlug(slug)
		setMessage(null)
		setMessageTone('info')
		try {
			await submit()
			if (!isCurrent()) return false
			if (lifetime.current?.signal.aborted) return false
			applyData()
			setMessage(successMessage)
			setMessageTone('info')
			return true
		} catch (error) {
			if (!isCurrent()) return false
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to update platform integrations.',
			)
			setMessageTone('error')
			return false
		} finally {
			if (isCurrent()) setPendingSlug(null)
		}
	}
	function handleLogoFileChange(event: ChangeEvent<HTMLInputElement>) {
		const input = event.currentTarget
		if (!(input instanceof HTMLInputElement)) return
		const file = input.files?.[0]
		if (!file) {
			setPendingLogoBase64(undefined)
			return
		}
		setRemoveLogoChecked(false)
		readerRef.current?.abort()
		const reader = new FileReader()
		readerRef.current = reader
		reader.onload = () => {
			if (typeof reader.result !== 'string') return
			const commaIndex = reader.result.indexOf(',')
			setPendingLogoBase64(
				commaIndex >= 0 ? reader.result.slice(commaIndex + 1) : reader.result,
			)
		}
		reader.readAsDataURL(file)
	}
	function handleSaveFormSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const form = event.currentTarget
		const formData = new FormData(form)
		const selection = props.selection
		const isEditing = !selection.isCreating && selection.selectedId != null
		// When editing, the URL selection is the row identity; an edited slug
		// input becomes a rename-in-place (newSlug) rather than a new row.
		// Compare canonicalized (the server does): a case-only edit is not a
		// rename.
		const inputSlug = String(formData.get('slug') ?? '').trim()
		const slug = (
			isEditing && selection.selectedId ? selection.selectedId : inputSlug
		).trim()
		const newSlug =
			isEditing &&
			inputSlug &&
			normalizeProviderKey(inputSlug) !== normalizeProviderKey(slug)
				? inputSlug
				: null
		const clientId = String(formData.get('clientId') ?? '').trim()
		const tokenUrl = String(formData.get('tokenUrl') ?? '').trim()
		const authorizeUrl = String(formData.get('authorizeUrl') ?? '').trim()
		const deviceAuthorizationUrl = String(
			formData.get('deviceAuthorizationUrl') ?? '',
		).trim()
		const flow = String(formData.get('flow') ?? '').trim()
		if (!slug || !clientId || !tokenUrl) {
			setMessage('Slug, client id, and token URL are required.')
			setMessageTone('error')
			return
		}
		if (flow !== 'pkce' && flow !== 'confidential' && flow !== 'device') {
			setMessage('Choose a valid OAuth flow.')
			setMessageTone('error')
			return
		}
		if (flow !== 'device' && !authorizeUrl) {
			setMessage('Authorize URL is required.')
			setMessageTone('error')
			return
		}
		if (flow === 'device' && !deviceAuthorizationUrl) {
			setMessage('Device authorization URL is required for device flow.')
			setMessageTone('error')
			return
		}
		const body: PlatformIntegrationSaveInput = {
			slug,
			...(newSlug ? { newSlug } : {}),
			clientId,
			tokenUrl,
			authorizeUrl,
			deviceAuthorizationUrl: deviceAuthorizationUrl || null,
			flow,
			provider: String(formData.get('provider') ?? '').trim() || null,
			label: String(formData.get('label') ?? '').trim() || null,
			description: String(formData.get('description') ?? '').trim() || null,
			apiBaseUrl: String(formData.get('apiBaseUrl') ?? '').trim() || null,
			scopeSeparator:
				String(formData.get('scopeSeparator') ?? '').trim() || null,
			enabled: formData.get('enabled') === 'on',
			allowedScopes: splitListInput(
				String(formData.get('allowedScopes') ?? ''),
			),
			defaultScopes: splitListInput(
				String(formData.get('defaultScopes') ?? ''),
			),
			requiredHosts: splitListInput(
				String(formData.get('requiredHosts') ?? ''),
			),
			extraAuthorizeParams: parseExtraAuthorizeParams(
				String(formData.get('extraAuthorizeParams') ?? ''),
			),
		}
		// Send null for the default option to clear a stored style.
		// Omitting the key retains the current setting.
		const tokenExchangeStyle = formData.get('tokenExchangeStyle')
		body.tokenExchangeStyle =
			tokenExchangeStyle === 'form' ||
			tokenExchangeStyle === 'basic-form' ||
			tokenExchangeStyle === 'basic-json'
				? tokenExchangeStyle
				: null
		const clientSecret = String(formData.get('clientSecret') ?? '').trim()
		if (clientSecret) {
			body.clientSecret = clientSecret
		}
		if (removeLogoChecked) {
			body.logoBase64 = ''
		} else if (pendingLogoBase64 !== undefined) {
			body.logoBase64 = pendingLogoBase64
		}
		void submitAdminAction(
			() => saveMutation.mutateAsync({ data: body }),
			'saving-form',
			newSlug
				? `Renamed platform integration ${slug} to ${newSlug}.`
				: isEditing
					? `Saved platform integration ${slug}.`
					: `Created platform integration ${slug}.`,
			slug,
		).then((ok) => {
			if (!ok) return
			resetFormState()
			const search = pageLocation.searchStr
			if (isEditing && !newSlug) {
				setFormRevision((current) => current + 1)
				return
			}
			// Creation and rename both land on the row's (new) detail URL.
			replaceLocation(
				platformIntegrationsRoute.buildDetailHref(newSlug ?? slug, search),
			)
		})
	}
	function handleToggleEnabled(app: AdminPlatformIntegrationApp) {
		void submitAdminAction(
			() =>
				saveMutation.mutateAsync({
					data: {
						slug: app.slug,
						clientId: app.clientId,
						tokenUrl: app.tokenUrl,
						authorizeUrl: app.authorizeUrl,
						deviceAuthorizationUrl: app.deviceAuthorizationUrl,
						flow: app.flow,
						enabled: !app.enabled,
					},
				}),
			'toggling-enabled',
			`${app.enabled ? 'Disabled' : 'Enabled'} ${app.slug}.`,
			app.slug,
		)
	}
	function handleToggleVisibility(app: AdminPlatformIntegrationApp) {
		const visibility = app.visibility === 'published' ? 'draft' : 'published'
		void submitAdminAction(
			() =>
				saveMutation.mutateAsync({
					data: {
						slug: app.slug,
						clientId: app.clientId,
						tokenUrl: app.tokenUrl,
						authorizeUrl: app.authorizeUrl,
						deviceAuthorizationUrl: app.deviceAuthorizationUrl,
						flow: app.flow,
						visibility,
					},
				}),
			'toggling-visibility',
			visibility === 'published'
				? `Published ${app.slug}.`
				: `Moved ${app.slug} to draft.`,
			app.slug,
		)
	}
	function handleDelete(app: AdminPlatformIntegrationApp) {
		void submitAdminAction(
			() =>
				removeMutation.mutateAsync({
					data: {
						slug: app.slug,
					},
				}),
			'deleting',
			`Deleted platform integration ${app.slug}.`,
			app.slug,
		).then((ok) => {
			if (!ok) return
			const selection = props.selection
			const search = pageLocation.searchStr
			resetFormState()
			if (selection.selectedId === app.slug || selection.isCreating) {
				replaceLocation(platformIntegrationsRoute.buildListHref(search))
			}
		})
	}
	function cancelEditor() {
		const search = pageLocation.searchStr
		resetSelectionState()
		replaceLocation(platformIntegrationsRoute.buildListHref(search))
	}
	function startCreateIntegration() {
		if (actionState !== 'idle') return
		const search = pageLocation.searchStr
		resetSelectionState()
		replaceLocation(platformIntegrationsRoute.buildNewHref(search))
	}
	const currentHref = props.currentHref
	const pending = false
	const status: string = 'ready'
	const selection = props.selection
	const filters = textSearch(pageLocation.search)
	const search = filters.q?.trim() ?? ''
	const filteredApps = filterApps(apps, search)
	const editingApp = selection.isCreating
		? null
		: (apps.find((app) => app.slug === selection.selectedId) ?? null)
	const isMutating = actionState !== 'idle'
	const showEditor = selection.isCreating || editingApp != null
	const showNotFound =
		selection.selectedId != null &&
		!selection.isCreating &&
		editingApp == null &&
		status === 'ready'
	return (
		<AccountManagementShell currentHref={currentHref} busy={pending}>
			<AdminPageHeader
				title="Admin platform integrations"
				description="Manage operator-provisioned OAuth apps stored in the platform_oauth_apps table. Users only discover and newly connect apps that are both enabled and published; drafts keep serving existing connections."
				currentHref={currentHref}
			/>
			{status === 'loading' ? (
				<p css={{ color: colors.textMuted, margin: 0 }}>
					Loading platform integrations…
				</p>
			) : null}
			{message ? (
				<AccountManagementMessage tone={messageTone}>
					{message}
				</AccountManagementMessage>
			) : null}
			{status === 'ready' ? (
				<RecordTable
					mode="expand"
					busy={pending}
					ariaLabel="Platform integrations"
					selectedId={selection.selectedId}
					createRow={
						selection.isCreating
							? {
									href: isMutating
										? undefined
										: platformIntegrationsRoute.buildNewHref(
												pageLocation.searchStr,
											),
									label: 'New integration',
								}
							: undefined
					}
					onNavigate={() => {
						resetSelectionState()
					}}
					countLabel={`${filteredApps.length} of ${apps.length} integrations`}
					emptyLabel={
						apps.length === 0
							? 'No platform integrations yet. Create one to get started.'
							: 'No integrations match the current search.'
					}
					toolbar={
						<>
							<RecordTableSearch
								label="Search integrations"
								placeholder="Search slug, provider, or label"
								value={filters.q ?? ''}
								onInput={(value) => {
									return updateSearch(value)
								}}
							/>
							<button
								type="button"
								disabled={isMutating}
								onClick={startCreateIntegration}
								css={primaryButtonCss}
							>
								Create integration
							</button>
						</>
					}
					columns={[
						{ key: 'slug', label: 'Slug', primary: true },
						{ key: 'provider', label: 'Provider' },
						{ key: 'label', label: 'Label', drop: 1 },
						{ key: 'enabled', label: 'Enabled' },
						{ key: 'visibility', label: 'Visibility' },
						{
							key: 'connections',
							label: 'Connections',
							align: 'end',
							drop: 2,
						},
						{ key: 'updated', label: 'Updated', drop: 3 },
					]}
					rows={filteredApps.map((app) => ({
						id: app.slug,
						href: isMutating
							? undefined
							: platformIntegrationsRoute.buildDetailHref(
									app.slug,
									pageLocation.searchStr,
								),
						cells: {
							slug: (
								<code
									css={{
										fontSize: typography.fontSize.sm,
										...recordCellClamp(24),
									}}
								>
									{app.slug}
								</code>
							),
							provider: <span css={clampedCellCss}>{app.provider || '—'}</span>,
							label: <span css={clampedCellCss}>{app.label || '—'}</span>,
							enabled: (
								<RecordDot
									active={app.enabled}
									title={app.enabled ? 'Enabled' : 'Disabled'}
								/>
							),
							visibility: (
								<span
									data-testid={`platform-integration-visibility-${app.slug}`}
								>
									{app.visibility === 'published' ? 'Published' : 'Draft'}
								</span>
							),
							connections: String(app.connectionCount),
							updated: (
								<span css={recordStampCss}>
									{formatTimestampDate(app.updatedAt)}
								</span>
							),
						},
					}))}
					record={
						showEditor ? (
							<IntegrationForm
								{...{
									editingApp,
									formRevision,
									actionState,
									pendingSlug,
									removeLogoChecked,
									onSubmit: handleSaveFormSubmit,
									onLogoFileChange: handleLogoFileChange,
									onRemoveLogoChange: (checked) => {
										setRemoveLogoChecked(checked)
										if (removeLogoChecked) {
											setPendingLogoBase64(undefined)
										}
									},
									onToggleEnabled: handleToggleEnabled,
									onToggleVisibility: handleToggleVisibility,
									onDelete: handleDelete,
									onCancel: cancelEditor,
								}}
							/>
						) : showNotFound ? (
							<p css={{ margin: 0, color: colors.textMuted }}>
								Platform integration not found.
							</p>
						) : null
					}
				/>
			) : null}
		</AccountManagementShell>
	)
}

const mutationResources = [
	'loadAdminPlatformIntegrations',
	'loadIntegrationsPage',
	'loadOnboarding',
	'loadAccountPage',
] as const
