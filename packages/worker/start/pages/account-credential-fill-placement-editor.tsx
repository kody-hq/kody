/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import { useState, type FormEvent } from 'react'
import {
	defaultFillPlacementDraft,
	type FillPlacementDraft,
	fillPlacementDraftFromView,
	fillPlacementViewFromDraft,
	formatFillPlacementSummary,
	type CredentialFillPlacementView,
} from '#universal/credential-fill-placement.ts'
import { saveCredentialPlacement } from '#start/server/credential-placement'
import { useCredentialMutation } from '../credential-mutation.ts'
import { CredentialFillPlacementFields } from './credential-fill-placement-fields.tsx'
import {
	accountActionsCss,
	accountFieldNoteCss,
} from './account-management-components.tsx'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

type Props = {
	credentialId: string
	placement: CredentialFillPlacementView | null
	orgSlug: string
}

const summaryCss = css({
	margin: 0,
	fontFamily: 'monospace',
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere',
	color: colors.text,
})

const errorCss = css({
	margin: 0,
	color: colors.error,
	fontSize: typography.fontSize.sm,
})

export function CredentialFillPlacementEditor(props: Props) {
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState<FillPlacementDraft>(
		defaultFillPlacementDraft(),
	)
	const [error, setError] = useState<string | null>(null)
	const [saved, setSaved] = useState<{
		placement: CredentialFillPlacementView | null
		from: CredentialFillPlacementView | null
	} | null>(null)
	const placement =
		saved && JSON.stringify(saved.from) === JSON.stringify(props.placement)
			? saved.placement
			: props.placement
	const mutation = useCredentialMutation(
		{ orgSlug: props.orgSlug },
		(next: CredentialFillPlacementView | null) =>
			saveCredentialPlacement({
				data: {
					orgSlug: props.orgSlug,
					credentialId: props.credentialId,
					placement: next,
				},
			}),
	)
	const saving = mutation.isPending
	function startEditing() {
		setEditing(true)
		setDraft(fillPlacementDraftFromView(placement))
		setError(null)
	}
	function cancel() {
		setEditing(false)
		setError(null)
	}
	async function onSave(event: FormEvent) {
		event.preventDefault()
		const next = fillPlacementViewFromDraft(draft)
		if (
			next === null &&
			!(draft.headers && draft.query && draft.path && draft.body)
		) {
			setError('Choose at least one request part.')
			return
		}
		setError(null)
		try {
			const result = await mutation.mutateAsync(next)
			setSaved({ placement: result.placement, from: props.placement })
			setEditing(false)
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : 'Unable to save placement.',
			)
		}
	}
	if (!editing) {
		return (
			<div css={css({ display: 'grid', gap: spacing.sm })}>
				<code css={summaryCss}>{formatFillPlacementSummary(placement)}</code>
				<p css={accountFieldNoteCss}>
					Placeholders for this credential may only fill the parts above. The
					gateway still fills today; enforcement ships later.
				</p>
				<div css={accountActionsCss}>
					<button
						type="button"
						css={getGhostButtonCss({ size: 'sm' })}
						onClick={startEditing}
					>
						Edit fill placement
					</button>
				</div>
			</div>
		)
	}
	return (
		<form
			onSubmit={(event) => {
				void onSave(event)
			}}
			css={css({ display: 'grid', gap: spacing.sm })}
		>
			<CredentialFillPlacementFields
				draft={draft}
				onChange={setDraft}
				disabled={saving}
				hideLegend
			/>
			{error ? <p css={errorCss}>{error}</p> : null}
			<div css={accountActionsCss}>
				<button
					type="submit"
					disabled={saving}
					css={getPillButtonCss({ size: 'sm' })}
				>
					{saving ? 'Saving…' : 'Save'}
				</button>
				<button
					type="button"
					disabled={saving}
					css={getGhostButtonCss({ size: 'sm' })}
					onClick={cancel}
				>
					Cancel
				</button>
			</div>
		</form>
	)
}
