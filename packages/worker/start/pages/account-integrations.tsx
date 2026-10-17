/** @jsxImportSource @emotion/react */
import {
	setIntegrationUsage,
	approveIntegrationPackage,
	disconnectIntegration,
	deleteOauthApp,
} from '#start/server/account-mutations'
import { textSearch } from '../filter-search.ts'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { relocateAccountHref } from '#universal/org-pages.ts'
import {
	useMutation,
	useMutationState,
	useQueryClient,
} from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { updateOrgPagePayload } from '../org-page-cache.ts'
import { settleConnectionResources } from '../connection-resource-settlement.ts'
import {
	integrationMutationOptions,
	projectIntegrationWrites,
	type IntegrationWrite,
} from '../integration-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	type AccountIntegrationListItem,
	type AccountIntegrationsLoaderData,
	type AccountOauthAppListItem,
} from '#universal/loader-data.ts'
import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { useUndoableAction } from '../components/use-undoable-action.ts'
import { UndoToast } from '../components/undo-toast.tsx'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import { RecordTable, RecordTableSearch } from './record-table.tsx'
import { primaryLinkCss } from '#universal/styles/style-primitives.ts'
import {
	type IntegrationUsageDraft,
	buildIntegrationHref,
	connectionLabel,
	deletedAppCopy,
	filterOauthApps,
	hostFromUrl,
	integrationListId,
	isBuiltInApp,
	oauthAppTitle,
	type IntegrationsSelection,
	resolveIntegrationsSelection,
} from './account-integrations-shared.ts'
import {
	renderIntegrationRecord,
	renderNamedProvider,
} from './account-integrations-detail.tsx'
import {
	renderApprovalCard,
	renderIntegrationsSetupSections,
	renderRecordNotFound,
} from './account-integrations-sections.tsx'

export function AccountIntegrationsPage({
	payload,
	currentHref,
	selection,
}: {
	payload: AccountIntegrationsLoaderData
	currentHref: string
	selection: IntegrationsSelection
}) {
	const queryClient = useQueryClient()
	const { actorKey, orgSlug, pageLocation } = useMatchedPageScope()
	const capture = useSubmitterScope()
	const writes = useMutationState({
		filters: {
			mutationKey: ['integrations', actorKey, orgSlug],
			exact: true,
			status: 'pending',
		},
		select: (mutation) => mutation.state.variables as IntegrationWrite,
	})
	const projected = useMemo(
		() => projectIntegrationWrites(payload, writes),
		[payload, writes],
	)
	const integrations = projected.integrations
	const apps = projected.apps
	const savedPackages = payload.savedPackages ?? []
	const platformCatalog = payload.platformCatalog ?? []
	const approval = payload.approval ?? null
	function updatePayload(
		update: (
			data: AccountIntegrationsLoaderData,
		) => AccountIntegrationsLoaderData,
		scope = { orgSlug },
	) {
		updateOrgPagePayload(
			queryClient,
			actorKey,
			'loadIntegrationsPage',
			scope,
			update,
		)
	}
	const mutation = useMutation({
		mutationKey: ['integrations', actorKey, orgSlug],
		...integrationMutationOptions(queryClient),
	})
	function invalidatePages() {
		return settleConnectionResources(queryClient, actorKey, orgSlug, [
			'loadIntegrationsPage',
		])
	}
	const [usageDrafts, setUsageDrafts] = useState(
		new Map<string, IntegrationUsageDraft>(),
	)
	const [usageSavingName, setUsageSavingName] = useState<string | null>(null)
	const [approvalSubmitting, setApprovalSubmitting] = useState(false)
	const [message, setMessage] = useState<string | null>(null)

	const router = useRouter()
	const navigate = (href: string) =>
		void router.navigate({ to: href, resetScroll: false })
	const [deleteArmed, setDeleteArmed] = useState(false)
	const [disconnectArmed, setDisconnectArmed] = useState<string | null>(null)
	const deleteAppConfirmation = {
		armed: deleteArmed,
		arm: () => setDeleteArmed(true),
		reset: () => setDeleteArmed(false),
	}
	const undoable = useUndoableAction()
	const [holdingOptimisticRemoval, setHoldingOptimisticRemoval] =
		useState(false)
	const mounted = useRef(false)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])
	const live = useRef({ integrations, apps })
	useLayoutEffect(() => {
		live.current = { integrations, apps }
	}, [integrations, apps])

	function isHoldingOptimisticRemoval() {
		return Boolean(undoable.pending) || holdingOptimisticRemoval
	}

	function getDisconnectConfirmation(name: string) {
		return {
			armed: disconnectArmed === name,
			arm: () => setDisconnectArmed(name),
			reset: () => setDisconnectArmed(null),
		}
	}

	function listHref() {
		return `${relocateAccountHref('/account/integrations', currentHref)}${getCurrentSearch()}`
	}

	function currentSelectionMissing() {
		return Boolean(
			resolveIntegrationsSelection({
				selection,
				apps: live.current.apps,
				integrations: live.current.integrations,
			}).missingKind,
		)
	}

	function finishOptimisticRemoval() {
		setHoldingOptimisticRemoval(false)
		if (!mounted.current || getCurrentHref() !== currentHref) return
		if (currentSelectionMissing()) {
			navigate(listHref())
			return
		}
	}

	function usageDraftFor(connection: AccountIntegrationListItem) {
		return (
			usageDrafts.get(connection.name) ?? {
				usageMode:
					connection.usageMode === 'packages'
						? ('packages' as const)
						: ('any' as const),
				allowedPackageIds: [...(connection.allowedPackageIds ?? [])],
			}
		)
	}

	function setUsageDraft(name: string, draft: IntegrationUsageDraft) {
		setUsageDrafts((current) => new Map(current).set(name, draft))
	}

	async function submitUsage(connection: AccountIntegrationListItem) {
		if (usageSavingName) return
		const isCurrent = capture()
		const draft = usageDraftFor(connection)
		setUsageSavingName(connection.name)
		try {
			await mutation.mutateAsync({
				orgSlug,
				actorKey,
				write: () =>
					setIntegrationUsage({
						data: {
							orgSlug: orgSlug ?? undefined,
							input: {
								name: connection.name,
								usageMode: draft.usageMode,
								allowedPackageIds:
									draft.usageMode === 'packages' ? draft.allowedPackageIds : [],
							},
						},
					}),
			})
			if (!isCurrent()) return
			setUsageDrafts((current) => {
				const next = new Map(current)
				next.delete(connection.name)
				return next
			})
			setMessage(`Updated usage for ${connectionLabel(connection)}.`)
		} catch (error) {
			if (!isCurrent()) return
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to update integration usage.',
			)
		} finally {
			if (isCurrent()) setUsageSavingName(null)
		}
	}

	async function submitApproval() {
		if (!approval || approvalSubmitting) return
		const isCurrent = capture()
		setApprovalSubmitting(true)
		try {
			await mutation.mutateAsync({
				orgSlug,
				actorKey,
				write: () =>
					approveIntegrationPackage({
						data: {
							orgSlug: orgSlug ?? undefined,
							input: {
								name: approval.name,
								packageId: approval.packageId,
							},
						},
					}),
			})
			if (!isCurrent()) return
			if (getCurrentHref() !== currentHref) return
			navigate(relocateAccountHref('/account/integrations', currentHref))
		} catch (error) {
			if (!isCurrent()) return
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to approve that package.',
			)
		} finally {
			if (isCurrent()) setApprovalSubmitting(false)
		}
	}

	async function startDisconnect(connection: {
		name: string
		accountLabel?: string | null
	}) {
		const isCurrent = capture()
		let decide!: (commit: boolean) => void
		const decision = new Promise<boolean>((resolve) => {
			decide = resolve
		})
		const write = mutation.mutateAsync({
			orgSlug,
			actorKey,
			write: () =>
				disconnectIntegration({
					data: {
						orgSlug: orgSlug ?? undefined,
						input: { name: connection.name },
					},
				}),
			decision,
			removeNames: [connection.name],
		})
		setDisconnectArmed(null)
		setHoldingOptimisticRemoval(true)
		await undoable.start({
			message: `Disconnected ${connectionLabel(connection)}.`,
			onCommit: async () => {
				try {
					decide(true)
					await write
					if (!isCurrent()) return
					finishOptimisticRemoval()
				} catch (error) {
					if (!isCurrent()) return
					setHoldingOptimisticRemoval(false)
					setMessage(
						error instanceof Error
							? error.message
							: 'Unable to disconnect that account.',
					)
				}
			},
			onUndo: async () => {
				decide(false)
				await write
				if (!isCurrent()) return
				setHoldingOptimisticRemoval(false)
			},
		})
	}

	async function startDeleteApp(app: AccountOauthAppListItem) {
		const isCurrent = capture()
		const title = oauthAppTitle(app)
		const connectionCount = app.connections.length
		let decide!: (commit: boolean) => void
		const decision = new Promise<boolean>((resolve) => {
			decide = resolve
		})
		const write = mutation.mutateAsync({
			orgSlug,
			actorKey,
			write: () =>
				deleteOauthApp({
					data: {
						orgSlug: orgSlug ?? undefined,
						input: { appSlug: app.slug },
					},
				}),
			decision,
			removeNames: app.connections.map((connection) => connection.name),
			removeApp: integrationListId(app),
		})
		setDeleteArmed(false)
		setHoldingOptimisticRemoval(true)
		await undoable.start({
			message: deletedAppCopy(title, connectionCount),
			onCommit: async () => {
				try {
					decide(true)
					await write
					if (!isCurrent()) return
					finishOptimisticRemoval()
				} catch (error) {
					if (!isCurrent()) return
					setHoldingOptimisticRemoval(false)
					setMessage(
						error instanceof Error
							? error.message
							: 'Unable to delete that integration.',
					)
				}
			},
			onUndo: async () => {
				decide(false)
				await write
				if (!isCurrent()) return
				setHoldingOptimisticRemoval(false)
			},
		})
	}

	function getCurrentHref() {
		return router.state.location.href
	}

	function getCurrentSearch() {
		return new URL(getCurrentHref(), 'http://localhost').search
	}

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

	function applyRotatedApp(rotatedApp: AccountOauthAppListItem) {
		updatePayload((data) => ({
			...data,
			apps: (data.apps ?? []).map((entry) =>
				entry.slug === rotatedApp.slug && !entry.platform ? rotatedApp : entry,
			),
			integrations: data.integrations.map((entry) =>
				entry.appSlug === rotatedApp.slug && !entry.platform
					? {
							...entry,
							clientId: rotatedApp.clientId,
							hasClientSecret: rotatedApp.hasClientSecret,
							appLabel: rotatedApp.label,
						}
					: entry,
			),
		}))
		void invalidatePages()
	}

	const filters = textSearch(pageLocation.search)
	const search = filters.q?.trim() ?? ''
	const setupIntro =
		apps.length === 0
			? 'No integrations yet. Pick a service and copy its prompt into your agent — setup takes a few minutes.'
			: 'Add another service: copy a prompt into your agent.'
	const filteredApps = filterOauthApps(apps, search)
	const { selectedApp, highlightedConnectionName, missingKind } =
		resolveIntegrationsSelection({
			selection,
			apps,
			integrations,
		})
	const showIntegrationNotFound =
		missingKind === 'integration' && !isHoldingOptimisticRemoval()
	const showConnectionNotFound =
		missingKind === 'connection' && !isHoldingOptimisticRemoval()
	const highlightedConnection = highlightedConnectionName
		? (integrations.find(
				(connection) => connection.name === highlightedConnectionName,
			) ?? null)
		: null

	return (
		<AccountManagementShell currentHref={currentHref} busy={false}>
			<AccountPageHeader
				entity="integrations"
				title="Integrations"
				description="Services you connect so Kody can use them."
				currentHref={currentHref}
			/>

			{message ? (
				<AccountManagementMessage tone="info">
					{message}
				</AccountManagementMessage>
			) : null}

			{approval
				? renderApprovalCard({
						currentHref,
						approval,
						submitting: approvalSubmitting,
						onApprove: () => void submitApproval(),
					})
				: null}

			{
				<>
					<RecordTable
						mode="expand"
						ariaLabel="Integrations"
						selectedId={selectedApp ? integrationListId(selectedApp) : null}
						recordLoading={Boolean(
							missingKind &&
							!showIntegrationNotFound &&
							!showConnectionNotFound,
						)}
						countLabel={`${filteredApps.length} of ${apps.length} integrations`}
						emptyLabel={
							apps.length === 0
								? 'No integrations yet.'
								: 'No integrations match the current filters.'
						}
						toolbar={
							<RecordTableSearch
								label="Search integrations"
								placeholder="Search names, hosts, or accounts"
								value={filters.q ?? ''}
								onInput={(value) => {
									return updateSearch(value)
								}}
							/>
						}
						columns={[
							{ key: 'name', label: 'Integration', primary: true },
							{
								key: 'accounts',
								label: 'Accounts',
								align: 'end',
							},
						]}
						rows={filteredApps.map((app) => ({
							id: integrationListId(app),
							href: buildIntegrationHref(app, getCurrentSearch(), currentHref),
							cells: {
								name: renderNamedProvider({
									providerKey: app.provider || app.slug,
									label: oauthAppTitle(app),
									logoPath: app.platformLogoPath ?? app.logoPath,
									autoLogoPath: app.autoLogoPath,
									catalogLogoPath: app.catalogLogoPath,
									host: hostFromUrl(app.authorizeUrl ?? app.tokenUrl),
									builtIn: isBuiltInApp(app),
								}),
								accounts: String(app.connectionCount),
							},
						}))}
						record={
							selectedApp
								? renderIntegrationRecord({
										selectedApp,
										integrations,
										apps,
										savedPackages,
										highlightedConnectionName,
										highlightedConnection,
										currentHref,
										currentSearch: getCurrentSearch(),
										deleteAppConfirmation,
										getDisconnectConfirmation,
										startDeleteApp,
										startDisconnect,
										usageDraftFor,
										setUsageDraft,
										submitUsage,
										usageSavingName,
										onRotated: applyRotatedApp,
									})
								: showConnectionNotFound
									? renderRecordNotFound('connection')
									: showIntegrationNotFound
										? renderRecordNotFound('integration')
										: null
						}
					/>
				</>
			}

			{renderIntegrationsSetupSections(setupIntro, platformCatalog)}

			<p css={{ margin: 0 }}>
				<SiteLink href="/account" css={primaryLinkCss}>
					Back to account
				</SiteLink>
			</p>
			{undoable.pending ? (
				<UndoToast
					message={undoable.pending.message}
					undoLabel={undoable.pending.undoLabel}
					onUndo={() => {
						void undoable.undo()
					}}
				/>
			) : null}
		</AccountManagementShell>
	)
}
