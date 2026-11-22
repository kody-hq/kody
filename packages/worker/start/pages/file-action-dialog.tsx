/** @jsxImportSource @emotion/react */
import { useQuery } from '@tanstack/react-query'
import { Button } from '../components/button.tsx'
import { Dialog } from '../components/dialog.tsx'
import { useState } from 'react'
import type { FileMetadata } from '#universal/files.ts'
import { colors } from '#universal/styles/tokens.ts'
import { readFileMovePreview } from '#start/server/file-collaboration'
import { Input, Select } from '../components/input.tsx'

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
	const [previewAttempt, setPreviewAttempt] = useState(0)
	const preview = useQuery({
		queryKey: [
			'file-move-preview',
			orgSlug,
			item.id,
			parent || null,
			previewAttempt,
		],
		queryFn: () =>
			readFileMovePreview({
				data: { orgSlug, fileId: item.id, parentId: parent || null },
			}),
		enabled: action === 'move' && collaborationEnabled,
		staleTime: Infinity,
		gcTime: 0,
		retry: false,
		refetchOnWindowFocus: false,
	})
	const movePreview: { changed: boolean; token: string } | null =
		preview.data ?? null
	const previewError = preview.isError
		? 'Could not check destination access.'
		: ''
	const [message, setMessage] = useState('')
	const title =
		action === 'rename'
			? 'Rename'
			: action === 'move'
				? 'Move to'
				: 'Move to trash'
	return (
		<Dialog
			open
			aria-label={`${title} ${item.name}`}
			onClose={onClose}
			size="sm"
		>
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
					<Input
						autoFocus
						aria-label="New name"
						value={name}
						maxLength={200}
						onChange={(event) => setName(event.target.value)}
					/>
				) : action === 'move' ? (
					<Select
						autoFocus
						aria-label="Destination"
						css={{ minWidth: 0, textOverflow: 'ellipsis' }}
						value={parent}
						onChange={(event) => {
							setParent(event.target.value)
						}}
					>
						{canCreate && <option value="">Workspace</option>}
						{destinations.map((option) => (
							<option key={option.id} value={option.id}>
								{option.name}
							</option>
						))}
					</Select>
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
								<Button
									type="button"
									variant="secondary"
									size="lg"
									onClick={() => {
										setPreviewAttempt((attempt) => attempt + 1)
									}}
								>
									Try again
								</Button>
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
					<Button type="button" variant="secondary" size="lg" onClick={onClose}>
						Cancel
					</Button>
					<Button
						disabled={
							busy ||
							(action === 'move' &&
								((!canCreate && !parent) ||
									(collaborationEnabled && !movePreview))) ||
							(action === 'rename' && !name.trim())
						}
						variant={action === 'trash' ? 'danger' : 'primary'}
						size="lg"
					>
						{action === 'move' ? 'Move' : title}
					</Button>
				</div>
			</form>
		</Dialog>
	)
}
