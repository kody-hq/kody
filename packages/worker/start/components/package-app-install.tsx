/** @jsxImportSource @emotion/react */
/** @jsxRuntime automatic */
import { keyframes } from '@emotion/react'
import { useState, useSyncExternalStore } from 'react'
import { isFeatureFlagEnabled } from '#client/feature-flags.ts'
import type { PackageAppInstallTarget } from '#universal/package-repo-actions.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { getSquircleCss } from '#universal/styles/style-primitives.ts'
import type { DesktopAppsBridge } from '../desktop-shell.ts'
import { useShellData } from '../routes/__root.tsx'
import { Button } from './button.tsx'
import { Dialog, DialogActions } from './dialog.tsx'
import { renderIcon } from './icon.tsx'

const subscribeNever = () => () => {}

type InstallState = 'idle' | 'installing' | 'installed' | 'error'

/**
 * Install as a desktop app. Rendered only inside the Kody desktop shell with
 * the flag on for the page's org (the package owner's org).
 */
export function PackageAppInstallControl(props: {
	install: PackageAppInstallTarget
	openHref: string
	css?: unknown
}) {
	const { session } = useShellData()
	const apps = useSyncExternalStore(
		subscribeNever,
		() => window.kodyDesktop?.apps ?? null,
		() => null,
	)
	const [open, setOpen] = useState(false)
	if (!apps || !isFeatureFlagEnabled(session, 'desktop-install-package-apps'))
		return null
	return (
		<>
			<Button
				type="button"
				data-testid="install-package-app"
				variant="secondary"
				css={props.css as never}
				onClick={() => setOpen(true)}
			>
				{renderIcon('monitor', { size: '1.1em' })}
				<span>Install</span>
			</Button>
			{open ? (
				<PackageAppInstallDialog
					apps={apps}
					install={props.install}
					openHref={props.openHref}
					onClose={() => setOpen(false)}
				/>
			) : null}
		</>
	)
}

export function PackageAppInstallDialog(props: {
	apps: Pick<DesktopAppsBridge, 'install'>
	install: PackageAppInstallTarget
	openHref: string
	onClose: () => void
}) {
	const [state, setState] = useState<InstallState>('idle')
	const [error, setError] = useState<string | null>(null)
	const { install } = props
	async function confirm() {
		setState('installing')
		setError(null)
		try {
			await props.apps.install({
				...install,
				openUrl: new URL(props.openHref, window.location.origin).href,
			})
			setState('installed')
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
			setState('error')
		}
	}
	return (
		<Dialog
			open
			onClose={props.onClose}
			dismissOnOutsideClick={state !== 'installing'}
			title={
				state === 'installed'
					? `${install.name} is installed`
					: `Install ${install.name}?`
			}
			description={
				state === 'installed'
					? 'It opens in its own window. Find it with your other apps.'
					: 'It opens in its own window with a launcher on this computer and always runs the latest published version.'
			}
			data-testid="install-package-app-dialog"
		>
			<div css={stageCss} data-state={state} aria-hidden>
				<div css={tileCss} data-state={state}>
					{install.iconUrl ? (
						<img src={install.iconUrl} alt="" css={iconCss} />
					) : (
						<span css={iconFallbackCss}>
							{install.name.slice(0, 1).toUpperCase()}
						</span>
					)}
				</div>
				<div css={dockCss} data-state={state} />
			</div>
			{error ? (
				<p role="alert" css={errorCss}>
					{error}
				</p>
			) : null}
			<DialogActions>
				{state === 'installed' ? (
					<Button
						type="button"
						variant="primary"
						data-testid="install-package-app-done"
						onClick={props.onClose}
					>
						Done
					</Button>
				) : (
					<>
						<Button
							type="button"
							variant="secondary"
							disabled={state === 'installing'}
							onClick={props.onClose}
						>
							Cancel
						</Button>
						<Button
							type="button"
							variant="primary"
							data-testid="install-package-app-confirm"
							disabled={state === 'installing'}
							onClick={() => void confirm()}
						>
							{state === 'installing' ? 'Installing' : 'Install'}
						</Button>
					</>
				)}
			</DialogActions>
		</Dialog>
	)
}

const drop = keyframes`
	0% { transform: translateY(0) scale(1); }
	45% { transform: translateY(-10px) scale(1.04); }
	80% { transform: translateY(34px) scale(0.62); }
	100% { transform: translateY(30px) scale(0.66); }
`
const settle = keyframes`
	0% { transform: scaleX(1); }
	70% { transform: scaleX(1); }
	85% { transform: scaleX(1.08); }
	100% { transform: scaleX(1); }
`
const bob = keyframes`
	0%, 100% { transform: translateY(0); }
	50% { transform: translateY(-4px); }
`

const stageCss = {
	position: 'relative',
	height: 132,
	display: 'grid',
	placeItems: 'center',
	marginBlock: 8,
} as const
const tileCss = {
	width: 72,
	height: 72,
	display: 'grid',
	placeItems: 'center',
	overflow: 'hidden',
	background: colors.surface,
	border: `1px solid ${colors.border}`,
	...getSquircleCss('lg'),
	zIndex: 1,
	'@media (prefers-reduced-motion: no-preference)': {
		'&[data-state="installing"]': {
			animation: `${bob} 900ms ease-in-out infinite`,
		},
		'&[data-state="installed"]': {
			animation: `${drop} 700ms cubic-bezier(0.3, 0.7, 0.4, 1) forwards`,
		},
	},
	'@media (prefers-reduced-motion: reduce)': {
		'&[data-state="installed"]': {
			transform: 'translateY(30px) scale(0.66)',
		},
	},
} as const
const dockCss = {
	position: 'absolute',
	insetInline: '22%',
	bottom: 8,
	height: 28,
	background: colors.primarySoft,
	border: `1px solid ${colors.border}`,
	...getSquircleCss('md'),
	'@media (prefers-reduced-motion: no-preference)': {
		'&[data-state="installed"]': {
			animation: `${settle} 700ms ease-out forwards`,
		},
	},
} as const
const iconCss = { width: '100%', height: '100%', objectFit: 'cover' } as const
const iconFallbackCss = {
	fontSize: typography.fontSize.xl,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
} as const
const errorCss = {
	margin: 0,
	color: colors.danger,
	fontSize: typography.fontSize.sm,
} as const
