/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import {
	useAppHotkeyList,
	useCustomHotkeys,
	useHotkeyRecorder,
	formatForDisplay,
	useHotkeyRegistrations,
	type AppHotkeyId,
} from '@tanstack/react-hotkeys'
import { smallButtonCss } from './styles.ts'
import { colors } from '#universal/styles/tokens.ts'

export function ShortcutSettings({ onBack }: { onBack: () => void }) {
	const items = useAppHotkeyList()
	const registered = useHotkeyRegistrations()
	const { findConflicts, setCustomHotkey, resetCustomHotkey } =
		useCustomHotkeys()
	const [recordingId, setRecordingId] = useState<AppHotkeyId | null>(null)
	const [error, setError] = useState<string | null>(null)
	const recorder = useHotkeyRecorder({
		maxSteps: 2,
		recordBy: 'key',
		detectConflicts: true,
		ignoreInputs: false,
		validate: (hotkey) => {
			if (!recordingId) return false
			const [conflict] = findConflicts(recordingId, hotkey)
			return conflict
				? `Already used by ${conflict.meta?.name ?? conflict.id}.`
				: true
		},
		onReject: (rejection) => setError(rejection.message),
		onCancel: () => {
			setRecordingId(null)
			setError(null)
		},
		onRecord: (hotkey) => {
			if (recordingId) {
				const conflicts = setCustomHotkey(recordingId, hotkey)
				if (conflicts.length) {
					setError('This shortcut is already in use.')
					return
				}
			}
			setRecordingId(null)
			setError(null)
		},
		onClear: () => {
			if (recordingId) setCustomHotkey(recordingId, null)
			recorder.stopRecording()
			setRecordingId(null)
		},
	})
	return (
		<section css={{ padding: 20 }} aria-label="Keyboard shortcuts">
			<div
				css={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
				}}
			>
				<h2 css={{ fontSize: 18, margin: 0 }}>Keyboard shortcuts</h2>
				<button
					css={smallButtonCss}
					onClick={() => {
						recorder.cancelRecording()
						onBack()
					}}
				>
					Back to search
				</button>
			</div>
			<p css={{ fontSize: 12, color: colors.textMuted }}>
				Record a shortcut or a two-key sequence. Enter saves, Escape cancels,
				Backspace clears.
			</p>
			{error ? <p role="alert">{error}</p> : null}
			<div
				css={{ display: 'grid', gap: 8, maxHeight: '50dvh', overflowY: 'auto' }}
			>
				{items.map(({ appHotkey, isCustom }) => (
					<div
						key={appHotkey.id}
						css={{
							display: 'flex',
							gap: 8,
							alignItems: 'center',
							minHeight: 32,
						}}
					>
						<span css={{ flex: 1 }}>{appHotkey.meta?.name}</span>
						<button
							css={smallButtonCss}
							aria-label={`Change ${appHotkey.meta?.name} shortcut`}
							onClick={() => {
								setRecordingId(appHotkey.id)
								setError(null)
								recorder.startRecording()
							}}
						>
							{recordingId === appHotkey.id
								? recorder.steps.length
									? formatForDisplay(recorder.steps)
									: 'Press keys…'
								: appHotkey.hotkey
									? formatForDisplay(appHotkey.hotkey)
									: 'Set shortcut'}
						</button>
						{isCustom ? (
							<button
								css={smallButtonCss}
								aria-label={`Reset ${appHotkey.meta?.name} shortcut`}
								onClick={() => {
									const conflict = appHotkey.defaultHotkey
										? findConflicts(appHotkey.id, appHotkey.defaultHotkey)[0]
										: undefined
									if (conflict) {
										setError(
											`Already used by ${conflict.meta?.name ?? conflict.id}.`,
										)
										return
									}
									resetCustomHotkey(appHotkey.id)
									setError(null)
								}}
							>
								Reset
							</button>
						) : null}
					</div>
				))}
			</div>
			<details css={{ marginTop: 16 }}>
				<summary>Inside the menu</summary>
				<dl css={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6 }}>
					{registered
						.filter(
							(item) =>
								item.options.scope === 'command-menu' &&
								!item.options.appHotkeyId &&
								item.options.meta?.name,
						)
						.map((item) => (
							<div key={item.id} css={{ display: 'contents' }}>
								<dt>{item.options.meta?.name}</dt>
								<dd css={{ margin: 0 }}>{formatForDisplay(item.hotkey)}</dd>
							</div>
						))}
				</dl>
			</details>
			<p css={{ fontSize: 12, color: colors.textMuted }}>
				Type &gt; for commands. Filter with repo:, job:, credential:, memory:,
				workflow:, doc:, page:, or workspace:.
			</p>
		</section>
	)
}
