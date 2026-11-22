/** @jsxImportSource @emotion/react */
import { Field } from '../components/field.tsx'
import { Button } from '../components/button.tsx'
import { adoptPackageFork } from '#start/server/package-mutations'
import type { CSSObject } from '@emotion/react'
import { useState, type FormEvent } from 'react'
import { usePackageMutation } from '../package-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'

import {
	communityForkAdoptionReviewNoteMinLength,
	communityForkAdoptionSectionId,
} from '#universal/community-fork-adoption.ts'
import type {
	AccountPackageCommunityFork,
	AccountPackageDetail,
} from '#universal/loader-data.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	getAccentCalloutCss,
	fieldDescriptionCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementPanel,
	TimestampValue,
	accountActionsCss,
} from './account-management-components.tsx'
import { Textarea } from '../components/input.tsx'

export function AccountPackageForkAdoption(props: {
	packageDetail: AccountPackageDetail
	communityFork: AccountPackageCommunityFork
}) {
	const mutation = usePackageMutation(
		props.packageDetail.id,
		adoptPackageFork,
		'adopt-community-fork',
	)
	const capture = useSubmitterScope()
	const [reviewNote, setReviewNote] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function submitAdoption(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (submitting) return
		setSubmitting(true)
		setError(null)

		const isCurrent = capture()
		try {
			await mutation.submit({
				packageId: props.packageDetail.id,
				reviewNote: reviewNote.trim(),
			})
			if (!isCurrent()) return
			setReviewNote('')
			setSubmitting(false)
		} catch (caught) {
			if (!isCurrent()) return
			setSubmitting(false)
			setError(
				caught instanceof Error ? caught.message : 'Could not adopt this fork.',
			)
		}
	}

	const { communityFork } = props
	const upstream = communityFork.listingName ?? 'a community listing'
	return (
		<AccountManagementPanel
			id={communityForkAdoptionSectionId}
			headingId="community-fork-adoption-title"
			testId="community-fork-adoption"
			title="Community fork"
		>
			{communityFork.adoptedAt ? (
				<div css={getAccentCalloutCss()}>
					<p css={{ margin: 0 }}>
						Adopted <TimestampValue value={communityFork.adoptedAt} />. This
						fork of {upstream} can read and use your user secrets like a package
						you wrote.
					</p>
					{communityFork.adoptionNote ? (
						<p css={fieldDescriptionCss}>
							Review note: {communityFork.adoptionNote}
						</p>
					) : null}
				</div>
			) : (
				<form
					method="post"
					css={{ display: 'grid', gap: spacing.sm }}
					onSubmit={submitAdoption}
				>
					<p css={fieldDescriptionCss}>
						This package is a fork of {upstream}. Until you adopt it, it can
						only read user secrets you allow one at a time. Adopting lets it
						read and use your user secrets like a package you wrote. Review the
						source first. Agents cannot adopt for you.
					</p>
					<Field label="What you reviewed">
						<Textarea
							name="reviewNote"
							data-testid="community-fork-adoption-note"
							required
							minLength={communityForkAdoptionReviewNoteMinLength}
							placeholder="Which files you read and why you trust this fork."
							value={reviewNote}
							onChange={(event) => {
								if (!(event.currentTarget instanceof HTMLTextAreaElement)) {
									return
								}
								setReviewNote(event.currentTarget.value)
							}}
						/>
					</Field>
					{error ? (
						<p role="alert" css={errorTextCss}>
							{error}
						</p>
					) : null}
					<div css={accountActionsCss}>
						<Button
							type="submit"
							data-testid="community-fork-adopt"
							disabled={
								submitting ||
								reviewNote.trim().length <
									communityForkAdoptionReviewNoteMinLength
							}
							variant="primary"
						>
							{submitting ? 'Adopting…' : 'Adopt fork'}
						</Button>
					</div>
				</form>
			)}
		</AccountManagementPanel>
	)
}

const errorTextCss = {
	margin: 0,
	color: colors.error,
	fontSize: typography.fontSize.sm,
} satisfies CSSObject
