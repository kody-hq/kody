/** @jsxImportSource @emotion/react */
import { connectSecretsInput } from '../connect-input.ts'
import { saveSecret as saveSecretRecord } from '#start/server/account-mutations'
import { routes } from '#universal/routes.ts'
import { ErrorAgentPromptButton } from '../components/error-agent-prompt-button.tsx'
import { buildHumanApprovalErrorAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import {
	readConnectSecretSetView,
	findMatchingSecretForSetup,
	hydrateEditorStateForExistingSecret,
	readExplicitPackageId,
	readInvalidExpiresAtQuery,
	resolvePackageIdForSecretSet,
	resolveSavePolicyFromSetup,
} from './connect-secret-set-shared.ts'
import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { connectSecretSetQuery } from '../connect-secret-set-query.ts'
import { usePageQuery } from '../page-query.ts'
import { SiteLink } from '../components/site-link.tsx'
import { type AccountSecretsLoaderData } from '#universal/loader-data.ts'
import { fillPlacementViewFromDraft } from '#universal/credential-fill-placement.ts'
import { CredentialFillPlacementFields } from './credential-fill-placement-fields.tsx'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { PasswordRevealInput } from '../components/password-reveal-input.tsx'
import {
	readAccountSecretsSaveWarning,
	createEditorStateFromNewSecretQuery,
	type EditorState,
} from './account-secrets-shared.ts'
import { getNewSecretValueAutofocusKey } from '#client/routes/new-secret-query.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	cardCss,
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
const pageCss = {
	...stackedPageCss,
	maxWidth: '32rem',
	margin: '0 auto',
}
const headerCss = {
	...pageHeaderCss,
	justifyItems: 'center',
	textAlign: 'center' as const,
}
const primaryButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
const secondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
export function ConnectSecretSetRoute({
	actorKey,
	currentHref,
}: {
	actorKey: string | null
	currentHref: string
}) {
	const client = useQueryClient()
	const options = connectSecretSetQuery(
		actorKey,
		connectSecretsInput(new URL(currentHref, 'https://kody.local').search),
	)
	const {
		data: { payload: data },
	} = usePageQuery(options)
	const [value, setValue] = useState('')
	const [showSecretValue, setShowSecretValue] = useState(false)
	const [fillPlacementOverride, setFillPlacementOverride] = useState<
		EditorState['fillPlacement'] | null
	>(null)
	const explicitPackageId = readExplicitPackageId(currentHref)
	const draft = createEditorStateFromNewSecretQuery(
		data.packageOptions,
		currentHref,
	)
	const packageResolution = resolvePackageIdForSecretSet({
		scope: draft.scope,
		explicitPackageId,
		packageOptions: data.packageOptions,
	})
	if (draft.scope === 'package')
		draft.packageId = packageResolution.packageId ?? ''
	const existing = findMatchingSecretForSetup(data.secrets, draft, {
		explicitPackageId,
	})
	const hydrated = existing
		? hydrateEditorStateForExistingSecret(draft, existing, currentHref)
		: draft
	const state = {
		...hydrated,
		value,
		fillPlacement: fillPlacementOverride ?? hydrated.fillPlacement,
	}
	const mutation = useMutation({
		mutationKey: ['secrets', actorKey],
		gcTime: 0,
		mutationFn: async ({
			state,
			href,
		}: {
			state: EditorState
			href: string
			actorKey: string | null
		}) => {
			const invalidExpires = readInvalidExpiresAtQuery(href)
			if (invalidExpires) throw new Error(invalidExpires)
			if (packageResolution.error) throw new Error(packageResolution.error)
			const policy = resolveSavePolicyFromSetup({ href, state, existing })
			const org = new URL(href, window.location.origin).searchParams
				.get('org')
				?.trim()
			const placement = fillPlacementViewFromDraft(state.fillPlacement)
			if (
				placement === null &&
				!(
					state.fillPlacement.headers &&
					state.fillPlacement.query &&
					state.fillPlacement.path &&
					state.fillPlacement.body
				)
			) {
				throw new Error('Choose at least one fill-placement part.')
			}
			const payload = (await saveSecretRecord({
				data: {
					orgSlug: org || undefined,
					fields: {
						currentId: state.currentId ?? existing?.id ?? null,
						name: state.name,
						scope: state.scope,
						packageId: packageResolution.packageId,
						description: state.description,
						expiresAt: policy.expiresAt,
						value: state.value,
						allowedHosts: policy.allowedHosts,
						allowedPackages: policy.allowedPackages,
						placement,
						provider:
							new URL(href, 'https://kody.local').searchParams
								.get('provider')
								?.trim() || null,
					},
				},
			})) as AccountSecretsLoaderData

			return payload
		},
		onSuccess: async (payload, { href, actorKey }) => {
			const queryKey = connectSecretSetQuery(
				actorKey,
				connectSecretsInput(new URL(href, 'https://kody.local').search),
			).queryKey
			await client.cancelQueries({ queryKey, exact: true })
			client.setQueryData(queryKey, (old) => (old ? { ...old, payload } : old))
			// Refresh the submitting actor without copying one org response into another org cache.
			await client.invalidateQueries({
				queryKey: ['page', actorKey, 'loadSecretsPage'],
			})
		},
	})
	const saveWarning = mutation.data
		? readAccountSecretsSaveWarning(mutation.data)
		: null
	const saved = mutation.isSuccess
	const saving = mutation.isPending
	const message = mutation.error?.message ?? null
	function saveSecret(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (saving || saved) return
		mutation.mutate(
			{ state, href: currentHref, actorKey },
			{ onSuccess: () => setValue('') },
		)
	}
	const view = readConnectSecretSetView({ name: state.name, saved })
	const hosts = state.allowedHosts.map((host) => host.trim()).filter(Boolean)
	const packagesById = new Map(data.packages.map((entry) => [entry.id, entry]))
	const packageGrants =
		state.scope === 'user'
			? state.allowedPackages.map((id) => id.trim()).filter(Boolean)
			: []
	const autofocusKey = getNewSecretValueAutofocusKey(currentHref)
	const setupError =
		readInvalidExpiresAtQuery(currentHref) ?? packageResolution.error ?? null
	return (
		<section css={pageCss} data-testid="connect-secret-set">
			<header css={headerCss}>
				<span css={pageEyebrowCss}>Set secret</span>
				<h1 css={pageTitleCss}>
					{view.saved
						? 'Secret saved'
						: view.hasName
							? 'Set this secret'
							: 'Open a secret setup link'}
				</h1>
				<p css={pageDescriptionCss}>
					{view.saved
						? 'This secret is saved. Return to your agent and continue.'
						: view.hasName
							? 'Paste the secret value below. Agents cannot set this for you.'
							: 'Open a setup link from Kody to save a secret value such as an API key or personal access token.'}
				</p>
			</header>

			{setupError ? (
				<section
					css={{
						...cardCss,
						border: `1px solid ${colors.danger}`,
					}}
					data-testid="connect-secret-set-error"
				>
					<p css={{ margin: 0, color: colors.danger }}>{setupError}</p>
					<ErrorAgentPromptButton
						prompt={buildHumanApprovalErrorAgentPrompt({
							activity:
								'Setting a secret value from a /connect/secret-set setup link.',
							errorMessage: setupError,
							ids: { path: '/connect/secret-set' },
						})}
					/>
				</section>
			) : null}

			{message ? (
				<>
					<p
						css={{ margin: 0, color: colors.danger }}
						data-testid="connect-secret-set-message"
					>
						{message}
					</p>
					{setupError ? null : (
						<ErrorAgentPromptButton
							prompt={buildHumanApprovalErrorAgentPrompt({
								activity:
									'Setting a secret value from a /connect/secret-set setup link.',
								errorMessage: message,
								ids: { path: '/connect/secret-set' },
							})}
						/>
					)}
				</>
			) : null}

			{view.showForm && !setupError ? (
				<section css={cardCss} data-testid="connect-secret-set-card">
					<form
						{...passwordManagerIgnoreProps}
						css={{ display: 'grid', gap: spacing.md }}
						onSubmit={(event) => {
							void saveSecret(event)
						}}
					>
						<div css={{ display: 'grid', gap: spacing.sm }}>
							<div css={{ display: 'grid', gap: spacing.xs }}>
								<span css={{ color: colors.textMuted }}>Secret</span>
								<code data-testid="connect-secret-set-name">{state.name}</code>
							</div>
							{state.description.trim() ? (
								<div css={{ display: 'grid', gap: spacing.xs }}>
									<span css={{ color: colors.textMuted }}>Description</span>
									<span css={{ color: colors.text }}>{state.description}</span>
								</div>
							) : null}
							{state.scope === 'package' ? (
								<div css={{ display: 'grid', gap: spacing.xs }}>
									<span css={{ color: colors.textMuted }}>Scope</span>
									<span css={{ color: colors.text }}>
										Package
										{state.packageId ? (
											<>
												{' '}
												<code>{state.packageId}</code>
											</>
										) : null}
									</span>
								</div>
							) : null}
							{hosts.length > 0 ? (
								<div css={{ display: 'grid', gap: spacing.xs }}>
									<span css={{ color: colors.textMuted }}>
										{hosts.length === 1 ? 'Host' : 'Hosts'}
									</span>
									<ul
										css={{
											margin: 0,
											paddingLeft: spacing.lg,
											display: 'grid',
											gap: spacing.xs,
										}}
									>
										{hosts.map((host) => (
											<li key={host}>
												<strong css={{ color: colors.text }}>{host}</strong>
											</li>
										))}
									</ul>
								</div>
							) : null}
							{packageGrants.length > 0 ? (
								<div
									css={{ display: 'grid', gap: spacing.xs }}
									data-testid="connect-secret-set-packages"
								>
									<span css={{ color: colors.textMuted }}>
										{packageGrants.length === 1
											? 'Allowed package'
											: 'Allowed packages'}
									</span>
									<ul
										css={{
											margin: 0,
											paddingLeft: spacing.lg,
											display: 'grid',
											gap: spacing.xs,
										}}
									>
										{packageGrants.map((packageId) => {
											const metadata = packagesById.get(packageId)
											return (
												<li key={packageId}>
													<strong css={{ color: colors.text }}>
														{metadata?.kodyId ?? packageId}
													</strong>
													{metadata ? (
														<span css={{ color: colors.textMuted }}>
															{' '}
															<code>{packageId}</code>
														</span>
													) : null}
												</li>
											)
										})}
									</ul>
								</div>
							) : null}
							{state.expiresAt.trim() ? (
								<div css={{ display: 'grid', gap: spacing.xs }}>
									<span css={{ color: colors.textMuted }}>Expires</span>
									<span css={{ color: colors.text }}>{state.expiresAt}</span>
								</div>
							) : null}
						</div>

						<CredentialFillPlacementFields
							draft={state.fillPlacement}
							onChange={setFillPlacementOverride}
							disabled={saving || saved}
						/>

						<div css={fieldCss}>
							<label htmlFor="connect-secret-set-value" css={fieldLabelCss}>
								Secret value
							</label>
							<PasswordRevealInput
								id="connect-secret-set-value"
								required
								autoFocus={Boolean(autofocusKey)}
								data-field="secret-value"
								data-testid="connect-secret-set-value"
								{...passwordManagerIgnoreProps}
								value={state.value}
								placeholder="Paste the secret value"
								revealNoun="secret value"
								revealed={showSecretValue}
								onRevealedChange={(next) => {
									setShowSecretValue(next)
								}}
								onInput={(event) => setValue(event.currentTarget.value)}
								css={inputCss}
							/>
						</div>

						<button
							type="submit"
							disabled={saving}
							data-testid="connect-secret-set-save"
							css={primaryButtonCss}
						>
							{saving ? 'Saving…' : 'Save secret'}
						</button>
					</form>
				</section>
			) : null}

			{view.saved && view.hasName ? (
				<section css={cardCss} data-testid="connect-secret-set-saved-card">
					{saveWarning ? (
						<p
							css={{ margin: 0, color: colors.warningText }}
							role="status"
							data-testid="connect-secret-set-save-warning"
						>
							{saveWarning}
						</p>
					) : null}
					<div css={{ display: 'grid', gap: spacing.sm }}>
						<div css={{ display: 'grid', gap: spacing.xs }}>
							<span css={{ color: colors.textMuted }}>Secret</span>
							<code>{state.name}</code>
						</div>
					</div>
					<SiteLink
						href={routes.accountCredentials.href()}
						css={secondaryButtonCss}
						data-testid="connect-secret-set-back"
					>
						Back to credentials
					</SiteLink>
				</section>
			) : view.showBackToSecrets ? (
				<SiteLink
					href={routes.accountCredentials.href()}
					css={secondaryButtonCss}
					data-testid="connect-secret-set-back"
				>
					Back to credentials
				</SiteLink>
			) : null}
		</section>
	)
}
