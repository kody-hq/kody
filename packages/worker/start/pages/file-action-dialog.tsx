/** @jsxImportSource @emotion/react */
import { ModalDialog } from '../components/modal-dialog.tsx'
import { useEffect, useState } from 'react'
import { type FileMetadata } from '#universal/files.ts'
import { colors } from '#universal/styles/tokens.ts'
import { accountInputCss } from './account-management-components.tsx'
import {
	getGhostButtonCss,
	getDangerPillCss,
	getSelectCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { readFileMovePreview } from '#start/server/file-collaboration'

export function FileActionDialog({
	item,
	action,
	destinations,
	canCreate,
	busy,
	orgSlug,
	onSubmit,
	onClose,
	collaborationEnabled = false,
}: {
	item: FileMetadata
	collaborationEnabled?: boolean
	action: 'rename' | 'move' | 'trash'
	destinations: Array<{ id: string; name: string }>
	canCreate: boolean
	busy: boolean
	orgSlug: string
	onSubmit: (changes: {
		name?: string
		parent_id?: string | null
		access_preview_token?: string
	}) => Promise<boolean | undefined>
	onClose: () => void
}) {
	const [name, setName] = useState(item.name)
	const [parent, setParent] = useState(item.parentId ?? '')
	const [movePreview, setMovePreview] = useState<{
		changed: boolean
		token: string
	} | null>(null)
	const [previewError, setPreviewError] = useState('')
	const [previewAttempt, setPreviewAttempt] = useState(0)
	useEffect(() => {
		if (action !== 'move' || !collaborationEnabled) return
		let active = true
		setMovePreview(null)
		setPreviewError('')
		void readFileMovePreview({
			data: { orgSlug, fileId: item.id, parentId: parent || null },
		}).then(
			(result) => {
				if (active) setMovePreview(result)
			},
			() => {
				if (active) setPreviewError('Could not check destination access.')
			},
		)
		return () => {
			active = false
		}
	}, [action, collaborationEnabled, orgSlug, item.id, parent, previewAttempt])
	const [message, setMessage] = useState('')
	const title =
		action === 'rename'
			? 'Rename'
			: action === 'move'
				? 'Move to'
				: 'Move to trash'
	return (
		<ModalDialog label={`${title} ${item.name}`} onClose={onClose} width={420}>
			<form
				onSubmit={async (event) => {
					event.preventDefault()
					setMessage('')

					const ok = await onSubmit(
						action === 'rename'
							? { name }
							: action === 'move'
								? {
										parent_id: parent || null,
										access_preview_token: movePreview?.token,
									}
								: {},
					)
					if (ok) onClose()
					else
						setMessage(
							'Could not update this item. Check the workspace message and try again.',
						)
				}}
				css={{
					display: 'grid',
					gridTemplateColumns: 'minmax(0, 1fr)',
					gap: 14,
				}}
			>
				<div>
					<h2 css={{ margin: 0, fontSize: '1.1rem' }}>{title}</h2>
					{action === 'move' && (
						<p
							css={{
								margin: '4px 0 0',
								color: colors.textMuted,
								fontSize: 13,
								overflowWrap: 'anywhere',
							}}
						>
							{item.name}
						</p>
					)}
				</div>
				{action === 'rename' ? (
					<input
						autoFocus
						aria-label="New name"
						css={accountInputCss}
						value={name}
						maxLength={200}
						onChange={(event) => setName(event.target.value)}
					/>
				) : action === 'move' ? (
					<select
						autoFocus
						aria-label="Destination"
						data-field-ring
						css={{ ...getSelectCss(), minWidth: 0, textOverflow: 'ellipsis' }}
						value={parent}
						onChange={(event) => {
							setMovePreview(null)
							setPreviewError('')
							setParent(event.target.value)
						}}
					>
						{canCreate && <option value="">Workspace</option>}
						{destinations.map((option) => (
							<option key={option.id} value={option.id}>
								{option.name}
							</option>
						))}
					</select>
				) : (
					<p css={{ margin: 0, overflowWrap: 'anywhere' }}>
						Move “{item.name}” and its contents to trash? You can restore them
						later.
					</p>
				)}
				{action === 'move' && collaborationEnabled && (
					<div css={{ fontSize: 13, color: colors.textMuted }}>
						{previewError ? (
							<>
								<p role="status" css={{ margin: 0, color: colors.danger }}>
									{previewError}
								</p>
								<button
									type="button"
									css={getGhostButtonCss()}
									onClick={() => {
										setPreviewError('')
										setPreviewAttempt((attempt) => attempt + 1)
									}}
								>
									Try again
								</button>
							</>
						) : !movePreview ? (
							<p role="status" css={{ margin: 0 }}>
								Checking destination access…
							</p>
						) : movePreview.changed ? (
							<p
								role="status"
								css={{
									margin: 0,
									padding: '8px 10px',
									border: `1px solid ${colors.border}`,
									borderRadius: 6,
								}}
							>
								This move changes inherited access. Direct shares stay with this
								item.
							</p>
						) : null}
					</div>
				)}
				{message && (
					<p
						role="status"
						css={{ margin: 0, color: colors.danger, fontSize: 13 }}
					>
						{message}
					</p>
				)}
				<div css={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
					<button type="button" css={getGhostButtonCss()} onClick={onClose}>
						Cancel
					</button>
					<button
						disabled={
							busy ||
							(action === 'move' &&
								((!canCreate && !parent) ||
									(collaborationEnabled && !movePreview))) ||
							(action === 'rename' && !name.trim())
						}
						css={action === 'trash' ? getDangerPillCss() : getPillButtonCss()}
					>
						{action === 'move' ? 'Move' : title}
					</button>
				</div>
			</form>
		</ModalDialog>
	)
}
