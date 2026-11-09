/** @jsxImportSource @emotion/react */
import { useRef } from 'react'
import { Combobox } from '@base-ui/react/combobox'
import {
	overlayItemCss,
	overlayPopupCss,
	overlayPositionerCss,
} from '../components/overlay-styles.ts'
import { type FileMetadata } from '#universal/files.ts'
import { type PageBlock } from '#universal/workspace-page.ts'
import { colors, typography } from '#universal/styles/tokens.ts'

type TextKind = Exclude<PageBlock['kind'], 'file'>
const blockTypes: Array<{
	kind: TextKind
	label: string
	icon: string
	description: string
}> = [
	{ kind: 'paragraph', label: 'Text', icon: 'T', description: '' },
	{
		kind: 'heading',
		label: 'Heading',
		icon: 'H',
		description: 'Section title',
	},
	{
		kind: 'bullet',
		label: 'Bulleted list',
		icon: '≡',
		description: 'An unordered list',
	},
	{ kind: 'task', label: 'Checklist', icon: '☑', description: 'Track a task' },
	{
		kind: 'quote',
		label: 'Quote',
		icon: '❞',
		description: 'A quotation or callout',
	},
	{
		kind: 'code',
		label: 'Code',
		icon: '</>',
		description: 'Preserve code formatting',
	},
]
export type BlockChoice = { kind: TextKind } | { kind: 'file'; fileId: string }

export function BlockPicker({
	anchor,
	initialQuery = '',
	files,
	includeFiles,
	onSelect,
	onClose,
}: {
	anchor: DOMRect
	initialQuery?: string
	files: FileMetadata[]
	includeFiles: boolean
	onSelect: (choice: BlockChoice) => void
	onClose: (restoreFocus?: boolean) => void
}) {
	const input = useRef<HTMLInputElement>(null)
	const choices = [
		...blockTypes.map((type) => ({
			id: type.kind,
			label: type.label,
			icon: type.icon,
			description: type.description,
			choice: { kind: type.kind } as BlockChoice,
		})),
		...(includeFiles
			? files.map((file) => ({
					id: file.id,
					label: file.name,
					icon: '↗',
					description: 'Embed file',
					choice: { kind: 'file', fileId: file.id } as BlockChoice,
				}))
			: []),
	]
	return (
		<Combobox.Root<(typeof choices)[number]>
			open
			items={choices}
			defaultInputValue={initialQuery}
			autoHighlight
			itemToStringLabel={(entry) => entry.label}
			filter={(entry, query) =>
				(entry.label + ' ' + entry.description)
					.toLowerCase()
					.includes(query.toLowerCase().trim())
			}
			onOpenChange={(open, details) => {
				if (!open && details.reason !== 'item-press')
					onClose(details.reason === 'escape-key')
			}}
			onValueChange={(entry) => {
				if (entry) onSelect(entry.choice)
			}}
		>
			<Combobox.Portal>
				<Combobox.Positioner
					anchor={{ getBoundingClientRect: () => anchor }}
					align="start"
					sideOffset={4}
					css={overlayPositionerCss}
				>
					<Combobox.Popup
						aria-label="Choose a block"
						initialFocus={input}
						finalFocus={false}
						css={{ ...overlayPopupCss, width: 284 }}
					>
						<Combobox.Input
							ref={input}
							aria-label="Search blocks and files"
							placeholder="Search blocks and files…"
							css={{
								width: '100%',
								boxSizing: 'border-box',
								border: 0,
								borderBottom: `1px solid ${colors.borderSubtle}`,
								padding: '8px 9px',
								background: 'transparent',
								color: 'inherit',
								font: 'inherit',
								fontSize: typography.fontSize.xs,
							}}
						/>
						<Combobox.List
							aria-label="Block types and files"
							css={{ paddingTop: 4 }}
						>
							{(entry: (typeof choices)[number]) => (
								<Combobox.Item
									key={entry.id}
									value={entry}
									css={overlayItemCss}
								>
									<span
										aria-hidden="true"
										css={{
											width: 32,
											height: 32,
											border: `1px solid ${colors.border}`,
											borderRadius: 5,
											display: 'grid',
											placeItems: 'center',
											background: colors.background,
											fontSize: entry.icon.length > 1 ? 11 : 20,
											fontWeight: 550,
											flexShrink: 0,
										}}
									>
										{entry.icon}
									</span>
									<span css={{ display: 'grid', gap: 1, minWidth: 0 }}>
										<span
											css={{
												fontSize: typography.fontSize.xs,
												fontWeight: 550,
												overflow: 'hidden',
												textOverflow: 'ellipsis',
												whiteSpace: 'nowrap',
											}}
										>
											{entry.label}
										</span>
										<span css={{ fontSize: 11, color: colors.textMuted }}>
											{entry.description}
										</span>
									</span>
								</Combobox.Item>
							)}
						</Combobox.List>
						<Combobox.Empty css={{ padding: 8, color: colors.textMuted }}>
							No matching blocks or files.
						</Combobox.Empty>
					</Combobox.Popup>
				</Combobox.Positioner>
			</Combobox.Portal>
		</Combobox.Root>
	)
}
