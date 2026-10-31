/** @jsxImportSource @emotion/react */
import { Global, type CSSObject } from '@emotion/react'
import { useEffect, useState } from 'react'
import { colors, typography } from '#universal/styles/tokens.ts'
import { toast } from '#client/toast.ts'
import {
	type DesktopNavigationState,
	type DesktopShell,
} from '../desktop-shell.ts'
import { SiteLink } from './site-link.tsx'
import { renderIcon } from './icon.tsx'

const cornerHeight = 44
const cornerWidth = 248

export function DesktopNavigation({ homeHref }: { homeHref: string }) {
	const [shell, setShell] = useState<DesktopShell | null>(null)
	const [state, setState] = useState<DesktopNavigationState | null>(null)
	const [addressOpen, setAddressOpen] = useState(false)
	useEffect(() => {
		const bridge = window.kodyDesktop
		if (bridge?.version !== 1) return
		let active = true
		const unsubscribe = bridge.navigation.onChange((next) => {
			if (active) setState(next)
		})
		void bridge.navigation
			.getState()
			.then((next) => {
				if (active) {
					setShell(bridge)
					setState(next)
				}
			})
			.catch((error: unknown) => toast.error(String(error)))
		return () => {
			active = false
			unsubscribe()
		}
	}, [])
	if (!shell || !state) return null
	const mac = state.platform === 'darwin'
	async function navigate(
		action: 'back' | 'forward' | 'home' | 'copyAddress' | 'openInBrowser',
	) {
		try {
			if (!shell) return
			await shell.navigation[action]()
			if (action === 'copyAddress') toast.success('Address copied')
			setAddressOpen(false)
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error))
		}
	}
	return (
		<>
			<Global
				styles={{
					...(state.integratedTitlebar && !state.fullscreen
						? {
								'a, button, input, select, textarea, [role="button"], [contenteditable="true"]':
									{ WebkitAppRegion: 'no-drag' },
							}
						: {}),
					':root': {
						'--desktop-corner-height': `${cornerHeight}px`,
						'--desktop-corner-width': `${cornerWidth}px`,
					},
				}}
			/>
			{state.integratedTitlebar && !state.fullscreen ? (
				<div
					aria-hidden="true"
					data-desktop-drag-strip
					css={{
						position: 'fixed',
						top: 0,
						insetInline: 0,
						height: 16,
						zIndex: 99,
						WebkitAppRegion: 'drag',
						pointerEvents: 'none',
					}}
				/>
			) : null}
			<nav
				aria-label="App navigation"
				data-desktop-navigation
				css={{
					position: 'fixed',
					top: 0,
					left: 0,
					width: cornerWidth,
					height: cornerHeight,
					zIndex: 100,
					display: 'flex',
					alignItems: 'center',
					gap: 4,
					paddingInline:
						mac && state.integratedTitlebar && !state.fullscreen
							? '88px 16px'
							: '16px',
					color: colors.textMuted,
					boxSizing: 'border-box',
					fontFamily: typography.fontFamily,
					WebkitAppRegion: 'drag',
					userSelect: 'none',
				}}
			>
				<button
					type="button"
					aria-label="Back"
					title="Back"
					disabled={!state.canGoBack}
					css={buttonCss}
					onClick={() => void navigate('back')}
				>
					{renderIcon('arrow-left', { size: '14px' })}
				</button>
				<button
					type="button"
					aria-label="Forward"
					title="Forward"
					disabled={!state.canGoForward}
					css={buttonCss}
					onClick={() => void navigate('forward')}
				>
					<span css={{ display: 'flex', transform: 'rotate(180deg)' }}>
						{renderIcon('arrow-left', { size: '14px' })}
					</span>
				</button>
				<SiteLink
					href={homeHref}
					aria-label="Home"
					title="Home"
					css={buttonCss}
				>
					{renderIcon('home', { size: '14px' })}
				</SiteLink>
				<div
					onKeyDown={(event) => {
						if (event.key === 'Escape') setAddressOpen(false)
					}}
					css={{
						marginLeft: 'auto',
						WebkitAppRegion: 'no-drag',
					}}
				>
					<button
						type="button"
						aria-label="Page address"
						title="Page address"
						aria-expanded={addressOpen}
						css={buttonCss}
						onClick={() => setAddressOpen(!addressOpen)}
					>
						{renderIcon('link', { size: '14px' })}
					</button>
					{addressOpen ? (
						<div
							onKeyDown={(event) => {
								if (event.key === 'Escape') setAddressOpen(false)
							}}
							css={{
								position: 'absolute',
								left: 16,
								top: cornerHeight,
								width: 'min(420px, calc(100vw - 32px))',
								boxSizing: 'border-box',
								background: colors.surface,
								border: `1px solid ${colors.border}`,
								borderRadius: 12,
								boxShadow: '0 8px 28px #0002',
								padding: 12,
								display: 'flex',
								gap: 8,
								flexWrap: 'wrap',
							}}
						>
							<input
								aria-label="Page address"
								readOnly
								value={state.url}
								onFocus={(event) => event.currentTarget.select()}
								css={{
									width: '100%',
									boxSizing: 'border-box',
									padding: 8,
									color: colors.text,
									background: colors.background,
									border: `1px solid ${colors.border}`,
									borderRadius: 6,
								}}
							/>
							<button
								type="button"
								css={textButtonCss}
								onClick={() => void navigate('copyAddress')}
							>
								Copy
							</button>
							<button
								type="button"
								css={textButtonCss}
								onClick={() => void navigate('openInBrowser')}
							>
								Open in browser
							</button>
						</div>
					) : null}
				</div>
			</nav>
		</>
	)
}
const buttonCss: CSSObject = {
	WebkitAppRegion: 'no-drag',
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: 28,
	height: 28,
	padding: 0,
	border: 0,
	borderRadius: 7,
	background: 'transparent',
	color: 'inherit',
	cursor: 'pointer',
	'&:hover:not(:disabled)': { background: colors.primarySoft },
	'&:disabled': { opacity: 0.3, cursor: 'default' },
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: 2,
	},
}
const textButtonCss: CSSObject = {
	...buttonCss,
	width: 'auto',
	paddingInline: 10,
	fontFamily: 'inherit',
	fontSize: 13,
}
