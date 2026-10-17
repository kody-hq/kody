/** @jsxImportSource @emotion/react */
import { type SaveSecretInput } from '#universal/secret-mutations.ts'
import { saveSecret } from '#start/server/account-mutations'
import { readAccountSecretsSaveWarning } from './account-secrets-shared.ts'
import { persistConnectOauthOrgSlug } from './connect-oauth-shared.ts'
import { SiteLink } from '../components/site-link.tsx'

import { type ReactNode, type FormEvent, useState } from 'react'
import { useCredentialMutation } from '../credential-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { PasswordRevealInput } from '../components/password-reveal-input.tsx'

import { AccountManagementShell } from './account-management-components.tsx'
import {
	credentialCreateHandoffHref,
	credentialCreateMode,
	isValueFormKind,
	buildKeySaveBody,
	createKeyFormState,
	credentialCreateAgentPrompt,
	credentialCreateTitle,
	credentialNeedApprovalHref,
	expiresAtDateValue,
	expiresAtHasTime,
	existingKindConflict,
	findExistingOrgKey,
	findMatchingCredentials,
	keyFormPackageId,
	keyFormProblem,
	keyLinkProblem,
	type KeyFormState,
	type ValueFormKind,
} from '#client/routes/connect-credential-shared.ts'
import {
	renderLoginExchange,
	renderLoginFields,
} from './connect-credential-login-fields.tsx'
import {
	renderKindList,
	renderMatches,
	renderPackageAccess,
} from './connect-credential-parts.tsx'
import {
	type CredentialKind,
	type CredentialListItem,
	credentialKinds,
	parseCredentialCreateQuery,
} from '#universal/credential-contracts.ts'
import {
	type AccountCredentialsResponse,
	credentialKindLabel,
} from '#universal/credentials-list.ts'
import { orgResourcePath, orgSlugFromPathname } from '#universal/org-pages.ts'
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
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
const primaryButtonCss = getPrimaryButtonCss({ size: 'lg', weight: 'semibold' })
const secondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
const mutedCss = { margin: 0, color: colors.textMuted }
const errorCss = { margin: 0, color: colors.danger }
const labelHintCss = {
	fontWeight: typography.fontWeight.normal,
	color: colors.textMuted,
}
/**
 * `/connect/credential` has no org; the worker redirects it to the signup
 * org's `/@slug/-/credentials/new`, so leave the SPA and let it.
 */
function valuePlaceholder(kind: ValueFormKind) {
	switch (kind) {
		case 'secret':
			return 'Paste the value'
		case 'url':
			return 'https://hooks.example.com/…'
		case 'signing':
			return 'Paste the signing secret or private key'
		case 'login':
			return ''
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}
function hostsHint(kind: ValueFormKind) {
	switch (kind) {
		case 'secret':
			return 'Kody fills the value only on HTTPS requests to these hosts.'
		case 'url':
			return 'Kody sends this URL only to these hosts. Its own host must be one of them.'
		case 'login':
			return 'Kody logs in and sends the session token only to these hosts. The exchange URL must be on one of them.'
		case 'signing':
			return 'Kody signs only for requests to these hosts.'
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}
/**
 * `/connect/credential`: the creation link agents hand out. One page picks
 * the kind (fixed when the link requires it), saves a Key, URL, login, or
 * signing credential in place, and hands OAuth and MCP to their own flows with
 * the link's prefill.
 */
export function ConnectCredentialRoute({
	data,
	currentHref: href,
}: {
	data: AccountCredentialsResponse
	currentHref: string
}) {
	const [form, setForm] = useState<KeyFormState>(() =>
		createKeyFormState(
			parseCredentialCreateQuery(
				new URL(href, 'https://kody.local').searchParams,
			),
		),
	)
	const [showValue, setShowValue] = useState(false)
	const [saving, setSaving] = useState(false)
	const [savedWarning, setSavedWarning] = useState<string | null>(null)
	const [seededReplaceLocksForId, setSeededReplaceLocksForId] = useState<
		string | null
	>(null)
	const [savedName, setSavedName] = useState<string | null>(null)
	const [savedPackageId, setSavedPackageId] = useState<string | null>(null)
	const [message, setMessage] = useState<string | null>(null)
	const capture = useSubmitterScope()
	const mutation = useCredentialMutation(
		{ orgSlug: data.orgSlug },
		(fields: SaveSecretInput) =>
			saveSecret({ data: { orgSlug: data.orgSlug, fields } }),
	)
	async function saveKey(
		event: FormEvent<HTMLFormElement>,
		kind: ValueFormKind,
	) {
		event.preventDefault()
		if (saving || mutation.isPending || !form) return
		const current = form
		const isCurrent = capture()
		const problem = keyFormProblem(current, kind)
		if (problem) {
			setMessage(problem)
			return
		}
		const existing = findExistingOrgKey(
			data?.credentials ?? [],
			current.name,
			keyFormPackageId(current, kind),
		)
		const kindConflict = existingKindConflict(existing, kind)
		if (kindConflict) {
			setMessage(kindConflict)
			return
		}
		if (existing && !current.replaceExisting) {
			setMessage(
				`A credential named ${current.name.trim()} already exists. Choose “Replace it” or pick another name.`,
			)
			return
		}
		const save = buildKeySaveBody({ kind, form: current, existing })
		if (!save.ok) {
			setMessage(save.error)
			return
		}
		setSaving(true)
		setMessage(null)
		try {
			const response = await mutation.mutateAsync(
				(({ action: _action, ...fields }) => fields)(save.body),
			)
			if (!isCurrent()) return
			const payload = response as {
				providerLinkError?: string | null
				renameCleanupError?: string | null
			}
			setSavedWarning(readAccountSecretsSaveWarning(payload))
			setSavedName(current.name.trim())
			setSavedPackageId(keyFormPackageId(current, kind))
			setForm({ ...current, value: '', loginFields: {} })
		} catch (error) {
			if (!isCurrent()) return
			setMessage(error instanceof Error ? error.message : 'Unable to save.')
		} finally {
			if (isCurrent()) setSaving(false)
		}
	}
	function renderKeyForm(input: {
		kind: ValueFormKind
		state: KeyFormState
		existing: CredentialListItem | null
		orgSlug: string
		/** Only on org paths: an org-less link cannot say which org owns the package. */
		forNeed: {
			orgSlug: string
			packageKodyId: string
			needKey: string
		} | null
		prompt: (error: string) => string
		packages: AccountCredentialsResponse['packages']
		linkProblem: string | null
	}) {
		const { kind, state, existing } = input
		const isKey = kind === 'secret'
		const kindConflict = existingKindConflict(existing, kind)
		const update = (patch: Partial<KeyFormState>) => {
			setForm({ ...state, ...patch })
		}
		if (savedName) {
			const saved = findExistingOrgKey(
				data?.credentials ?? [],
				savedName,
				savedPackageId,
			)
			const approvalHref =
				saved && input.forNeed
					? credentialNeedApprovalHref({
							...input.forNeed,
							credentialId: saved.id,
						})
					: null
			return (
				<section css={cardCss} data-testid="connect-credential-saved">
					{savedWarning ? (
						<p
							css={{ margin: 0, color: colors.warningText }}
							role="status"
							data-testid="connect-credential-save-warning"
						>
							{savedWarning}
						</p>
					) : null}
					<p css={{ margin: 0 }}>
						<strong>{savedName}</strong> is saved. Return to your agent and
						continue.
					</p>
					{approvalHref && input.forNeed ? (
						<p css={{ margin: 0 }}>
							If <code>{input.forNeed.packageKodyId}</code> should always use it
							for <code>{input.forNeed.needKey}</code>,{' '}
							<SiteLink
								href={approvalHref}
								data-testid="connect-credential-approve"
							>
								make it your default
							</SiteLink>
							.
						</p>
					) : null}
					{saved ? (
						<SiteLink
							href={orgResourcePath(
								input.orgSlug,
								'credentials',
								encodeURIComponent(saved.id),
							)}
							css={secondaryButtonCss}
						>
							View credential
						</SiteLink>
					) : null}
				</section>
			)
		}
		return (
			<section css={cardCss} data-testid="connect-credential-key-form">
				<form
					{...passwordManagerIgnoreProps}
					css={{ display: 'grid', gap: spacing.md }}
					onSubmit={(event) => {
						void saveKey(event, kind)
					}}
				>
					<div css={fieldCss}>
						<label htmlFor="connect-credential-name" css={fieldLabelCss}>
							Name
						</label>
						<input
							id="connect-credential-name"
							required
							pattern="[a-zA-Z0-9._\-]+"
							value={state.name}
							placeholder="OPENAI_API_KEY"
							css={inputCss}
							onChange={(event) => {
								setSeededReplaceLocksForId(null)
								update({
									name: event.currentTarget.value,
									replaceExisting: false,
								})
							}}
						/>
						<span css={mutedCss}>
							{isKey ? (
								<>
									Code refers to it as{' '}
									<code>{`{{secret:${state.name || 'NAME'}}}`}</code>.
								</>
							) : (
								'Packages ask Kody to use it by name. They never see the value.'
							)}
						</span>
					</div>
					{kindConflict ? (
						<p css={errorCss} data-testid="connect-credential-kind-conflict">
							{kindConflict}
						</p>
					) : existing ? (
						<label
							css={{
								display: 'flex',
								gap: spacing.sm,
								alignItems: 'center',
							}}
						>
							<input
								type="checkbox"
								checked={state.replaceExisting}
								data-testid="connect-credential-replace"
								onChange={(event) => {
									const replaceExisting = event.currentTarget.checked
									const seedLocks =
										replaceExisting && seededReplaceLocksForId !== existing.id
									if (seedLocks) setSeededReplaceLocksForId(existing.id)
									update({
										replaceExisting,
										allowedPackages: seedLocks
											? [
													...new Set([
														...(existing.lockedToPackageIds ?? []),
														...state.allowedPackages,
													]),
												]
											: state.allowedPackages,
										provider:
											replaceExisting && !state.provider.trim()
												? (existing.provider ?? '')
												: state.provider,
									})
								}}
							/>
							<span>
								{isKey ? (
									<>
										A credential named <code>{existing.name}</code> already
										exists. Replace it (its hosts stay; edit package locks
										below).
									</>
								) : (
									<>
										A credential named <code>{existing.name}</code> already
										exists. Replace it (edit package locks below; its hosts
										become the ones below).
									</>
								)}
							</span>
						</label>
					) : null}
					{kind === 'login' ? (
						renderLoginFields({ state, update })
					) : (
						<div css={fieldCss}>
							<label htmlFor="connect-credential-value" css={fieldLabelCss}>
								Value
							</label>
							<PasswordRevealInput
								id="connect-credential-value"
								required
								autoFocus={Boolean(state.name)}
								{...passwordManagerIgnoreProps}
								value={state.value}
								placeholder={valuePlaceholder(kind)}
								revealNoun="value"
								revealed={showValue}
								onRevealedChange={(next) => {
									setShowValue(next)
								}}
								css={inputCss}
								onChange={(event) =>
									update({ value: event.currentTarget.value })
								}
							/>
							<span css={mutedCss}>
								Only Kody sees the value. Agents and package code never do.
							</span>
						</div>
					)}
					<div css={fieldCss}>
						<label htmlFor="connect-credential-hosts" css={fieldLabelCss}>
							{isKey ? 'Allowed hosts' : 'Hosts'}{' '}
							<span css={labelHintCss}>(one per line)</span>
						</label>
						<textarea
							id="connect-credential-hosts"
							rows={2}
							required={!isKey}
							value={state.hosts}
							placeholder={
								isKey ? 'api.example.com' : 'api.example.com or *.example.com'
							}
							css={inputCss}
							onChange={(event) => update({ hosts: event.currentTarget.value })}
						/>
						<span css={mutedCss}>{hostsHint(kind)}</span>
					</div>
					{kind === 'login' ? renderLoginExchange({ state, update }) : null}
					<div css={fieldCss}>
						<label htmlFor="connect-credential-provider" css={fieldLabelCss}>
							Provider <span css={labelHintCss}>(optional)</span>
						</label>
						<input
							id="connect-credential-provider"
							value={state.provider}
							placeholder="openai"
							css={inputCss}
							onChange={(event) =>
								update({ provider: event.currentTarget.value })
							}
						/>
					</div>
					<div css={fieldCss}>
						<label htmlFor="connect-credential-description" css={fieldLabelCss}>
							Description <span css={labelHintCss}>(optional)</span>
						</label>
						<input
							id="connect-credential-description"
							value={state.description}
							css={inputCss}
							onChange={(event) =>
								update({ description: event.currentTarget.value })
							}
						/>
					</div>
					{renderPackageAccess({
						state,
						packages: input.packages,
						packageKeys: isKey,
						update,
					})}
					<div css={fieldCss}>
						<label htmlFor="connect-credential-expires" css={fieldLabelCss}>
							Expires <span css={labelHintCss}>(optional)</span>
						</label>
						<input
							id="connect-credential-expires"
							type="date"
							value={expiresAtDateValue(state.expiresAt)}
							css={inputCss}
							onChange={(event) =>
								update({ expiresAt: event.currentTarget.value })
							}
						/>
						{expiresAtHasTime(state.expiresAt) ? (
							<span
								css={mutedCss}
								data-testid="connect-credential-expires-time"
							>
								The link sets {state.expiresAt} (UTC). Pick a date to change it.
							</span>
						) : null}
						{existing?.expiresAt &&
						state.replaceExisting &&
						!state.expiresAt ? (
							<span css={mutedCss}>
								Leave empty to keep its current expiry.
							</span>
						) : null}
					</div>
					{input.linkProblem ? (
						<p css={errorCss} data-testid="connect-credential-link-problem">
							{input.linkProblem}
						</p>
					) : null}
					{message ? (
						<div
							role="alert"
							css={{
								display: 'grid',
								gap: spacing.sm,
								justifyItems: 'start',
							}}
						>
							<p css={errorCss} data-testid="connect-credential-message">
								{message}
							</p>
							<CopyTextButton
								value={input.prompt(message)}
								idleLabel="Copy prompt for your agent"
							/>
						</div>
					) : null}
					<button
						type="submit"
						disabled={
							saving || input.linkProblem !== null || kindConflict !== null
						}
						data-testid="connect-credential-save"
						css={primaryButtonCss}
					>
						{saving ? 'Saving…' : isKey ? 'Save key' : 'Save credential'}
					</button>
				</form>
			</section>
		)
	}
	const state = form as KeyFormState
	const search = new URL(href, 'http://localhost').searchParams
	const query = parseCredentialCreateQuery(search)
	const pathOrgSlug = orgSlugFromPathname(
		new URL(href, 'http://localhost').pathname,
	)
	const orgSlug = data?.orgSlug ?? ''
	const selected = query.kind ?? 'secret'
	const kinds = query.kindLocked && selected ? [selected] : credentialKinds
	const matches = data ? findMatchingCredentials(data.credentials, query) : []
	const packages = data?.packages ?? []
	const existing = findExistingOrgKey(
		data?.credentials ?? [],
		state.name,
		keyFormPackageId(state, selected),
	)
	const linkProblem = data ? keyLinkProblem({ query, packages }) : null
	const scopedPackage =
		query.packageScopedTo === null || (selected && selected !== 'secret')
			? null
			: (packages.find((entry) => entry.id === query.packageScopedTo) ?? null)
	const pageUrl =
		typeof window === 'undefined'
			? href
			: new URL(href, window.location.origin).toString()
	return (
		<AccountManagementShell>
			<section css={stackedPageCss} data-testid="connect-credential">
				<header css={pageHeaderCss}>
					<span css={pageEyebrowCss}>Add a credential</span>
					<h1 css={pageTitleCss}>
						{query.kind
							? credentialCreateTitle(query.kind)
							: 'Add a credential'}
					</h1>
					<p css={pageDescriptionCss}>
						{query.packageKodyId && query.needKey ? (
							<>
								For <code>{query.packageKodyId}</code>, which needs{' '}
								<code>{query.needKey}</code>.{' '}
							</>
						) : null}
						{scopedPackage ? (
							<>
								Only <code>{scopedPackage.kodyId}</code> can read this key.{' '}
							</>
						) : null}
						Kody keeps the value and places it on requests for you. It never
						appears to agents or package code.
					</p>
				</header>

				{renderMatches({ matches, orgSlug })}

				<section
					aria-label="Credential kind"
					css={{ display: 'grid', gap: spacing.sm }}
				>
					{query.kindLocked && selected ? (
						<p css={mutedCss}>
							This link asks for a {credentialKindLabel(selected)} credential.
						</p>
					) : (
						<p css={mutedCss}>
							{query.kind
								? 'Suggested by the link. Pick another kind if it fits better.'
								: 'A key fits most credentials. Pick another kind if it fits better.'}
						</p>
					)}
					{renderKindList({ kinds, selected, href })}
				</section>

				{renderKindBody({
					kind: selected,
					search,
					orgSlug,
					valueForm: (kind) =>
						renderKeyForm({
							kind,
							state,
							existing,
							orgSlug,
							packages,
							linkProblem,
							forNeed:
								pathOrgSlug && query.packageKodyId && query.needKey
									? {
											orgSlug: pathOrgSlug,
											packageKodyId: query.packageKodyId,
											needKey: query.needKey,
										}
									: null,
							prompt: (error) =>
								credentialCreateAgentPrompt({
									kind,
									query,
									pageUrl,
									error,
								}),
						}),
				})}
			</section>
		</AccountManagementShell>
	)
}

function renderKindBody(input: {
	kind: CredentialKind
	search: URLSearchParams
	orgSlug: string
	valueForm: (kind: ValueFormKind) => ReactNode
}) {
	const mode = credentialCreateMode(input.kind)
	switch (mode) {
		case 'value-form':
			return isValueFormKind(input.kind) ? input.valueForm(input.kind) : null
		case 'handoff': {
			const kind = input.kind === 'oauth' ? 'oauth' : 'mcp'
			const provider = input.search.get('provider')?.trim()
			return (
				<section css={cardCss} data-testid="connect-credential-handoff">
					<p css={{ margin: 0 }}>
						{kind === 'oauth'
							? `Kody sends you to ${provider ? `${provider}'s` : 'the provider’s'} sign-in, then brings you back.`
							: 'Add the server’s URL. Kody connects to it and asks you to sign in when the server needs it.'}
					</p>

					<SiteLink
						href={credentialCreateHandoffHref({
							kind,
							search: input.search,
							orgSlug: input.orgSlug,
						})}
						css={primaryButtonCss}
						data-testid="connect-credential-continue"
						onClick={() => {
							if (kind === 'oauth') persistConnectOauthOrgSlug(input.orgSlug)
						}}
					>
						{kind === 'oauth'
							? 'Continue to connect'
							: 'Continue to add server'}
					</SiteLink>
				</section>
			)
		}
		default: {
			const exhaustive: never = mode
			return exhaustive
		}
	}
}
