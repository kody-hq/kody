/** @jsxImportSource @emotion/react */
import { useServerFn } from '@tanstack/react-start'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouteContext, useParams } from '@tanstack/react-router'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { NotFoundPage } from '../components/not-found-page.tsx'
import { resolvePackageListIconUrl } from '#universal/identity-icon-urls.ts'
import {
	type PackageCredentialsLoaderData,
	type PackageCredentialsTab,
	readPackageCredentialsTabPath,
} from '#universal/package-credentials-page.ts'
import {
	fallbackDefaultBranchName,
	getPackageTreeHref,
} from '#universal/package-files.ts'
import { renderPackageRepoChrome } from '../components/package-repo-nav.tsx'
import { cardCss, cardTitleCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import { detailArticleCss } from '../components/community-detail-sections.tsx'
import { packageCredentialsQueryFilter } from '../package-credentials-cache.ts'
import { postPackageCredentialChanges } from '../package-credential-changes.ts'
import {
	type PackageCredentialsEnablementAction,
	type PackageCredentialsView,
} from '#universal/credential-contracts.ts'
import { usePackageMappingEditor } from './package-credentials-editor.tsx'
import {
	type PackageTabContext,
	renderCredentialsTab,
	renderMappingsTab,
} from './package-credentials-tabs.tsx'
import { renderTriggersTab } from './package-credentials-triggers-tab.tsx'
function renderTab(tab: PackageCredentialsTab, context: PackageTabContext) {
	switch (tab) {
		case 'credentials':
			return renderCredentialsTab(context)
		case 'mappings':
			return renderMappingsTab(context)
		case 'triggers':
			return renderTriggersTab(context)
		default: {
			const exhaustive: never = tab
			return exhaustive
		}
	}
}
function packageCredentialsAgentPrompt(input: {
	pageUrl: string
	error: string
}) {
	return [
		`I opened my package's credentials on Kody: ${input.pageUrl}`,
		`Kody said: ${input.error}`,
		'Help me find out why. Do not ask me to paste any credential value into chat.',
	].join('\n')
}
function renderViewError(input: { pageUrl: string; error: string }) {
	return (
		<section
			role="alert"
			data-testid="package-credentials-error"
			css={{
				...cardCss,
				borderLeft: `4px solid ${colors.danger}`,
				justifyItems: 'start',
				gap: spacing.sm,
			}}
		>
			<h2 css={cardTitleCss}>Kody could not load these credentials</h2>
			<p css={{ margin: 0 }}>{input.error}</p>
			<CopyTextButton
				value={packageCredentialsAgentPrompt(input)}
				idleLabel="Copy prompt for your agent"
			/>
		</section>
	)
}
export function PackageCredentialsRoute({
	payload: data,
	currentHref,
}: {
	payload: PackageCredentialsLoaderData
	currentHref: string
}) {
	const client = useQueryClient()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const path = readPackageCredentialsTabPath(
		new URL(currentHref, 'https://kody.local').pathname,
	)
	const params = useParams({ strict: false })
	const shell = data.ok ? data.shell : null
	const username = shell?.username ?? params.username ?? ''
	const kodyId = shell?.kodyId ?? params.kodyId ?? ''
	const replaceView = async (
		view: PackageCredentialsView,
		postedTo: { username: string; kodyId: string; actorKey: string | null },
	) => {
		const filter = packageCredentialsQueryFilter(postedTo)
		await client.cancelQueries(filter)
		client.setQueriesData<{
			payload: PackageCredentialsLoaderData
		}>(filter, (cached) =>
			cached?.payload.ok
				? { ...cached, payload: { ...cached.payload, view, viewError: null } }
				: cached,
		)
	}
	const sendEnablement = useServerFn(postPackageCredentialChanges)
	const enablementMutation = useMutation({
		mutationKey: ['package-trigger-enablement', actorKey, username, kodyId],
		mutationFn: async (input: {
			actorKey: string | null
			username: string
			kodyId: string
			action: PackageCredentialsEnablementAction
		}) => {
			const result = await sendEnablement({
				username: input.username,
				kodyId: input.kodyId,
				enablements: [input.action],
			})
			if (result === undefined) return undefined
			if (result.kind === 'saved') return result.view
			throw new Error(
				result.kind === 'error'
					? result.message
					: result.kind === 'refused'
						? (result.errors[0]?.message ??
							'Kody could not update this trigger.')
						: 'Please sign in again.',
			)
		},
		onSuccess: async (view, input) => {
			if (view) await replaceView(view, input)
		},
		onSettled: (_view, _error, input) =>
			client.invalidateQueries(packageCredentialsQueryFilter(input)),
	})
	const ownEnablement =
		enablementMutation.variables?.actorKey === actorKey &&
		enablementMutation.variables?.username === username &&
		enablementMutation.variables?.kodyId === kodyId
	const busyKey =
		ownEnablement && enablementMutation.isPending
			? (enablementMutation.variables?.action.enablementId ??
				`${enablementMutation.variables?.action.trigger.kind}:${enablementMutation.variables?.action.trigger.name}`)
			: null
	const editor = usePackageMappingEditor(username, {
		readPage: () => ({ username, kodyId, orgSlug: username }),
		onSaved: (view, postedTo) => replaceView(view, { ...postedTo, actorKey }),
	})
	if (!path || !data.ok) return <NotFoundPage />
	const view = data.view
	const pageUrl = currentHref
	return (
		<article css={detailArticleCss} data-testid={`package-${path.tab}`}>
			{renderPackageRepoChrome({
				username,
				kodyId,
				isPrivate: shell?.isPrivate ?? false,
				isListed: shell?.isListed ?? false,
				viewerIsOwner: true,
				viewerCanManage: shell?.viewerCanManage ?? false,
				viewerCanManageAccess: shell?.viewerCanManageAccess ?? false,
				active: path.tab,
				filesHref: getPackageTreeHref({
					username,
					kodyId,
					listingId: shell?.listingId ?? null,
					ref: shell?.defaultBranch || fallbackDefaultBranchName,
				}),
				description: shell?.description ?? '',
				ownerProfilePublic: shell?.ownerProfilePublic ?? true,
				iconUrl: resolvePackageListIconUrl({
					username,
					kodyId,
					listingId: shell?.listingId ?? null,
					listingIconCommit: null,
					publishedCommit: shell?.publishedCommit ?? null,
				}),
				iconName: kodyId,
			})}

			{view
				? renderTab(path.tab, {
						orgSlug: username,
						username,
						kodyId,
						view,
						renderMappingCell: editor.renderCell,
						setTriggerEnablement: (action) => {
							if (!busyKey)
								enablementMutation.mutate({
									actorKey,
									username,
									kodyId,
									action,
								})
						},
						enablementBusyKey: busyKey,
						enablementError:
							ownEnablement && enablementMutation.error
								? enablementMutation.error.message
								: null,
					})
				: null}
			{data && !data.view
				? renderViewError({
						pageUrl,
						error:
							data.viewError ??
							'Kody could not load this package’s credentials.',
					})
				: null}
		</article>
	)
}
