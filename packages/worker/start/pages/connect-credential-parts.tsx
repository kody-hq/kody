/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { AllowedPackagesPicker } from '../components/allowed-packages-picker.tsx'
import { type ComboboxOption } from '../components/combobox.tsx'

import {
	credentialCreateKindSummary,
	type KeyFormState,
	writeCredentialCreateKind,
} from '#client/routes/connect-credential-shared.ts'
import {
	type CredentialKind,
	type CredentialListItem,
} from '#universal/credential-contracts.ts'
import {
	type AccountCredentialsResponse,
	credentialKindLabel,
} from '#universal/credentials-list.ts'
import { orgResourcePath } from '#universal/org-pages.ts'
import {
	cardCss,
	fieldCss,
	fieldLabelCss,
} from '#universal/styles/style-primitives.ts'
import { colors, radius, spacing } from '#universal/styles/tokens.ts'
const kindGridCss = {
	display: 'grid',
	gap: spacing.sm,
	gridTemplateColumns: 'repeat(auto-fill, minmax(14rem, 1fr))',
	margin: 0,
	padding: 0,
	border: 'none',
}
const kindOptionCss = {
	display: 'grid',
	gap: spacing.xs,
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	color: colors.text,
	textDecoration: 'none',
	'&:hover': { borderColor: colors.primary },
}
const kindOptionSelectedCss = {
	...kindOptionCss,
	borderColor: colors.primary,
	boxShadow: `inset 0 0 0 1px ${colors.primary}`,
}
const mutedCss = { margin: 0, color: colors.textMuted }
const choiceRowCss = {
	display: 'flex',
	gap: spacing.sm,
	alignItems: 'baseline',
}
function renderKindOption(input: {
	kind: CredentialKind
	selected: boolean
	href: string
}) {
	return (
		<li key={input.kind} css={{ listStyle: 'none' }}>
			<SiteLink
				href={input.href}
				aria-current={input.selected ? 'true' : undefined}
				data-testid={`credential-kind-${input.kind}`}
				css={input.selected ? kindOptionSelectedCss : kindOptionCss}
			>
				<strong>{credentialKindLabel(input.kind)}</strong>
				<span css={{ color: colors.textMuted }}>
					{credentialCreateKindSummary(input.kind)}
				</span>
			</SiteLink>
		</li>
	)
}
export function renderMatches(input: {
	matches: ReadonlyArray<CredentialListItem>
	orgSlug: string
}) {
	if (input.matches.length === 0) return null
	return (
		<section css={cardCss} data-testid="connect-credential-matches">
			<p css={{ margin: 0 }}>
				You already have{' '}
				{input.matches.length === 1
					? 'a credential'
					: `${input.matches.length} credentials`}{' '}
				from this provider. If one fits, you do not need a new one.
			</p>
			<ul css={{ margin: 0, paddingLeft: spacing.lg }}>
				{input.matches.map((credential) => (
					<li key={credential.id}>
						<SiteLink
							href={orgResourcePath(
								input.orgSlug,
								'credentials',
								encodeURIComponent(credential.id),
							)}
						>
							{credential.name}
						</SiteLink>{' '}
						<span css={{ color: colors.textMuted }}>
							({credentialKindLabel(credential.kind)})
						</span>
					</li>
				))}
			</ul>
		</section>
	)
}
/** The kind chooser: each option keeps the link's prefill. */
export function renderKindList(input: {
	kinds: ReadonlyArray<CredentialKind>
	selected: CredentialKind | null
	href: string
}) {
	return (
		<ul css={kindGridCss}>
			{input.kinds.map((kind) =>
				renderKindOption({
					kind,
					selected: kind === input.selected,
					href: writeCredentialCreateKind(input.href, kind),
				}),
			)}
		</ul>
	)
}
/**
 * Who can read an org credential: any package in the org, or only a picked
 * lock list. A package-private Key is not offered here; it is created from the
 * package's own Credentials tab, or by a link that names the package.
 */
export function PackageAccessField(input: {
	state: KeyFormState
	packages: AccountCredentialsResponse['packages']
	/** Only a Key can belong to one package; other kinds can only be locked. */
	packageKeys: boolean
	update: (patch: Partial<KeyFormState>) => void
}) {
	const { state, packages, packageKeys, update } = input
	const [onlyChosen, setOnlyChosen] = useState(
		() => state.allowedPackages.length > 0,
	)
	if (packageKeys && state.packageScope === 'package') {
		const owner = packages.find((entry) => entry.id === state.packageId)
		return (
			<div data-testid="connect-credential-package-access" css={fieldCss}>
				<span css={fieldLabelCss}>Which packages can read it</span>
				<p css={mutedCss} data-testid="connect-credential-package-key">
					{owner ? (
						<>
							Only <code>{owner.kodyId}</code> can read this key. No other
							package or agent code reads it.
						</>
					) : (
						'This link makes a key for one package, so no other package or agent code reads it.'
					)}
				</p>
			</div>
		)
	}
	const restricted = onlyChosen || state.allowedPackages.length > 0
	const options: Array<ComboboxOption> = packages.map((entry) => ({
		id: entry.id,
		label: entry.kodyId,
		keywords: [entry.id, entry.name],
	}))
	return (
		<fieldset
			data-testid="connect-credential-package-access"
			css={{ ...fieldCss, border: 'none', margin: 0, padding: 0 }}
		>
			<legend css={fieldLabelCss}>Which packages can read it</legend>
			<label css={choiceRowCss}>
				<input
					type="radio"
					name="connect-credential-package-access"
					checked={!restricted}
					onChange={() => {
						setOnlyChosen(false)
						update({ allowedPackages: [] })
					}}
				/>
				<span>Any package in this org</span>
			</label>
			<label css={choiceRowCss}>
				<input
					type="radio"
					name="connect-credential-package-access"
					checked={restricted}
					onChange={() => setOnlyChosen(true)}
				/>
				<span>Only these packages</span>
			</label>
			{restricted ? (
				<AllowedPackagesPicker
					id="connect-credential-allowed-package"
					options={options}
					selected={state.allowedPackages}
					unknownLabel={
						<>
							Package{' '}
							<span css={{ color: colors.textMuted, fontWeight: 'normal' }}>
								(not found in this org)
							</span>
						</>
					}
					allSelectedText="Every package in this org is selected."
					noOptionsText="This org has no packages yet."
					onAdd={(id) =>
						update({
							allowedPackages: [...new Set([...state.allowedPackages, id])],
						})
					}
					onRemove={(id) =>
						update({
							allowedPackages: state.allowedPackages.filter(
								(entry) => entry !== id,
							),
						})
					}
				/>
			) : null}
			<span css={mutedCss}>
				{restricted
					? 'Only the packages you add can read it. With no packages selected, any package in this org can use it.'
					: 'Any package in this org can use it. Choose "Only these packages" to lock it to some.'}
			</span>
		</fieldset>
	)
}
