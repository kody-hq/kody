/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import { SiteLink } from '../components/site-link.tsx'
import { MetadataGrid } from './account-management-components.tsx'
import { CredentialFillPlacementEditor } from './account-credential-fill-placement-editor.tsx'
import { recordBodyCss } from './record-table.tsx'
import { fillPlacementAnchor } from '#universal/credential-placement-approval.ts'
import { type CredentialProviderBindingItem } from '#universal/credentials-list.ts'
import { orgResourcePath } from '#universal/org-pages.ts'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'

const mutedCss = css({ margin: 0, color: colors.textMuted })

/** A custom secret provider (vault) credential: who unlocks it and where its placeholders may fill. */
export function renderVaultCredentialDetail(input: {
	binding: CredentialProviderBindingItem
	packageName: string
	orgSlug: string
}) {
	const { binding } = input
	const name = binding.provider ?? binding.providerId
	return (
		<section aria-label={`${name} details`} css={recordBodyCss}>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<h2 css={cardTitleCss}>{name}</h2>
				<p css={descriptionCss}>
					A vault credential. Kody resolves secret placeholders that reference
					items in this vault when a run needs them, so code never sees the
					values.
				</p>
			</div>

			<MetadataGrid
				items={[
					{ label: 'Kind', value: 'Custom secret provider' },
					{ label: 'Owner', value: 'Org' },
					{
						label: 'Unlocked by',
						value: `${binding.doorSecretName} in ${input.packageName}`,
					},
				]}
			/>

			<div css={fieldCss} id={fillPlacementAnchor}>
				<span css={fieldLabelCss}>Fill placement</span>
				<div css={{ display: 'grid', gap: spacing.xs }}>
					<CredentialFillPlacementEditor
						key={`${binding.id}:placement`}
						credentialId={binding.id}
						placement={binding.placement}
						orgSlug={input.orgSlug}
					/>
					<p css={mutedCss}>
						Applies to every placeholder that references this vault. Only an
						owner can widen it here; code can only narrow it.
					</p>
				</div>
			</div>

			<div>
				<SiteLink
					href={orgResourcePath(input.orgSlug, 'secret-providers')}
					css={getGhostButtonCss({ size: 'sm' })}
				>
					Manage secret providers
				</SiteLink>
			</div>
		</section>
	)
}
