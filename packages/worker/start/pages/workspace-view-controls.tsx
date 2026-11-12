/** @jsxImportSource @emotion/react */
import { useEffect, useState, type RefObject } from 'react'
import { formatForDisplay, useHotkeys } from '@tanstack/react-hotkeys'
import { colors } from '#universal/styles/tokens.ts'
export function WorkspaceViewControls({
	view,
	changeView,
	browserRoot,
}: {
	view: 'columns' | 'icons' | 'list' | 'gallery'
	changeView: (view: 'columns' | 'icons' | 'list' | 'gallery') => void
	browserRoot: RefObject<HTMLElement | null>
}) {
	const [shortcutsReady, setShortcutsReady] = useState(false)
	useEffect(() => setShortcutsReady(true), [])
	const hover = colors.borderSubtle
	const iconButton = {
		display: 'inline-grid',
		placeItems: 'center',
		width: 28,
		height: 28,
		padding: 0,
		border: 0,
		borderRadius: 4,
		color: colors.textMuted,
		cursor: 'pointer',
		'@media (hover: hover)': {
			'&:hover': { background: hover, color: colors.text },
		},
		'@media (pointer: coarse)': { width: 36, height: 36 },
		'&:focus-visible': {
			outline: `2px solid ${colors.primary}`,
			outlineOffset: 2,
		},
	}

	useHotkeys(
		[
			{
				hotkey: 'Mod+Alt+1',
				callback: () => changeView('columns'),
				options: { meta: { name: 'Column view' } },
			},
			{
				hotkey: 'Mod+Alt+2',
				callback: () => changeView('icons'),
				options: { meta: { name: 'Icon view' } },
			},
			{
				hotkey: 'Mod+Alt+4',
				callback: () => changeView('gallery'),
				options: { meta: { name: 'Gallery view' } },
			},
			{
				hotkey: 'Mod+Alt+3',
				callback: () => changeView('list'),
				options: { meta: { name: 'Detailed list view' } },
			},
		],
		{ target: browserRoot, ignoreInputs: true, ignoreDefaultPrevented: true },
	)
	return (
		<div
			role="group"
			aria-label="View mode"
			css={{ display: 'flex', gap: 1, flexShrink: 0 }}
		>
			{(['columns', 'icons', 'list', 'gallery'] as const).map((mode) => (
				<button
					key={mode}
					title={
						(mode === 'columns'
							? 'Columns'
							: mode === 'icons'
								? 'Icons'
								: mode === 'list'
									? 'Detailed list'
									: 'Gallery') +
						(shortcutsReady
							? ' · ' +
								formatForDisplay(
									mode === 'columns'
										? 'Mod+Alt+1'
										: mode === 'icons'
											? 'Mod+Alt+2'
											: mode === 'list'
												? 'Mod+Alt+3'
												: 'Mod+Alt+4',
								)
							: '')
					}
					aria-label={
						mode === 'columns'
							? 'Columns'
							: mode === 'icons'
								? 'Icons'
								: mode === 'list'
									? 'Detailed list'
									: 'Gallery'
					}
					aria-pressed={view === mode}
					aria-keyshortcuts={
						mode === 'columns'
							? 'Control+Alt+1 Meta+Alt+1'
							: mode === 'icons'
								? 'Control+Alt+2 Meta+Alt+2'
								: mode === 'list'
									? 'Control+Alt+3 Meta+Alt+3'
									: 'Control+Alt+4 Meta+Alt+4'
					}
					onClick={() => changeView(mode)}
					css={{
						...iconButton,
						background: view === mode ? hover : 'transparent',
						color: view === mode ? colors.text : colors.textMuted,
					}}
				>
					<svg
						aria-hidden
						width="16"
						height="16"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.2"
					>
						{mode === 'columns' ? (
							<>
								<rect x="1.5" y="2" width="13" height="12" rx="1.5" />
								<path d="M6 2v12M10.5 2v12" />
							</>
						) : mode === 'icons' ? (
							<>
								<rect x="2" y="2" width="4" height="4" rx=".7" />
								<rect x="10" y="2" width="4" height="4" rx=".7" />
								<rect x="2" y="10" width="4" height="4" rx=".7" />
								<rect x="10" y="10" width="4" height="4" rx=".7" />
							</>
						) : mode === 'list' ? (
							<path d="M2 3h12M2 8h12M2 13h12" />
						) : (
							<>
								<rect x="1.5" y="2" width="13" height="8" rx="1" />
								<path d="M2 12h3v2H2zm4.5 0h3v2h-3zm4.5 0h3v2h-3z" />
							</>
						)}
					</svg>
				</button>
			))}
		</div>
	)
}

export function ThumbnailSizeControl({
	size,
	onChange,
}: {
	size: number
	onChange: (value: number) => void
}) {
	return (
		<label
			title="Thumbnail size"
			css={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: 6,
				color: colors.textMuted,
				flexShrink: 0,
			}}
		>
			<svg
				aria-hidden="true"
				width="12"
				height="12"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
			>
				<rect x="5" y="5" width="6" height="6" rx="1" />
			</svg>
			<input
				type="range"
				aria-label="Thumbnail size"
				min={84}
				max={220}
				step={4}
				value={size}
				aria-valuetext={`${size} pixels`}
				onChange={(event) => onChange(Number(event.target.value))}
				css={{
					width: 80,
					height: 24,
					margin: 0,
					accentColor: colors.primary,
					cursor: 'pointer',
				}}
			/>
			<svg
				aria-hidden="true"
				width="14"
				height="14"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
			>
				<rect x="2" y="2" width="12" height="12" rx="1" />
			</svg>
		</label>
	)
}
