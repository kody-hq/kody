/** @jsxImportSource @emotion/react */
import {
	Children,
	isValidElement,
	createContext,
	useContext,
	useId,
	useState,
	type ComponentProps,
	type ReactNode,
} from 'react'
import { type CSSObject } from '@emotion/react'
type TabsSize = 'md' | 'lg'
type ContextValue = {
	id: string
	active: string | undefined
	disabled: boolean
	select: (name: string) => void
}
const TabsContext = createContext<ContextValue | null>(null)
function useTabs() {
	const context = useContext(TabsContext)
	if (!context) throw new Error('Tabs components must be inside Tabs.')
	return context
}
function firstTabName(children: ReactNode): string | undefined {
	for (const child of Children.toArray(children)) {
		if (
			!isValidElement<{
				name?: string
				disabled?: boolean
				children?: ReactNode
			}>(child)
		)
			continue
		if (child.type === Tab && !child.props.disabled) return child.props.name
		const nested = firstTabName(child.props.children)
		if (nested) return nested
	}
	return undefined
}
export function Tabs({
	activeTab,
	defaultActiveTab,
	disabled = false,
	onActiveTabChange,
	size = 'md',
	children,
	...props
}: ComponentProps<'div'> & {
	activeTab?: string
	defaultActiveTab?: string
	disabled?: boolean
	onActiveTabChange?: (active: string) => void
	size?: TabsSize
	children?: ReactNode
}) {
	const id = useId()
	const [local, setLocal] = useState(defaultActiveTab ?? firstTabName(children))
	const active = activeTab ?? local
	return (
		<TabsContext
			value={{
				id,
				active,
				disabled,
				select(name) {
					if (disabled) return
					setLocal(name)
					onActiveTabChange?.(name)
				},
			}}
		>
			<div {...props} css={[tabsRootCss, sizeStyles[size]]}>
				{children}
			</div>
		</TabsContext>
	)
}
export function TabList({ onKeyDown, ...props }: ComponentProps<'div'>) {
	const context = useTabs()
	return (
		<div
			{...props}
			role="tablist"
			tabIndex={-1}
			aria-disabled={context.disabled || undefined}
			css={tabsListCss}
			onKeyDown={(event) => {
				onKeyDown?.(event)
				if (event.defaultPrevented || context.disabled) return
				if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
					return
				const tabs = Array.from(
					event.currentTarget.querySelectorAll<HTMLButtonElement>(
						'[role="tab"]:not(:disabled)',
					),
				)
				const index = tabs.indexOf(document.activeElement as HTMLButtonElement)
				if (index < 0 || !tabs.length) return
				event.preventDefault()
				const next =
					event.key === 'Home'
						? 0
						: event.key === 'End'
							? tabs.length - 1
							: (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) %
								tabs.length
				tabs[next]?.focus()
				tabs[next]?.click()
			}}
		/>
	)
}
export function Tab({
	name,
	disabled = false,
	onClick,
	...props
}: Omit<ComponentProps<'button'>, 'name'> & { name: string }) {
	const context = useTabs()
	const selected = context.active === name
	return (
		<button
			{...props}
			type="button"
			id={context.id + '-tab-' + name}
			role="tab"
			aria-selected={selected}
			aria-controls={context.id + '-panel-' + name}
			disabled={disabled || context.disabled}
			tabIndex={selected ? 0 : -1}
			data-state={selected ? 'active' : 'inactive'}
			css={tabsTabCss}
			onClick={(event) => {
				onClick?.(event)
				if (!event.defaultPrevented) context.select(name)
			}}
		/>
	)
}
export function TabPanel({
	name,
	...props
}: ComponentProps<'div'> & { name: string }) {
	const context = useTabs()
	return (
		<div
			{...props}
			id={context.id + '-panel-' + name}
			role="tabpanel"
			aria-labelledby={context.id + '-tab-' + name}
			hidden={context.active !== name}
			tabIndex={0}
			css={tabsPanelCss}
		/>
	)
}
const tabSliderBackground =
	'linear-gradient(180deg, rgba(0, 0, 0, 0) 33%, light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)) 100%), light-dark(#FFFFFF, #1a1a1a)'
const tabSliderShadow =
	'0 0 0 0.5px light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.12)), 0 1px 1px -0.5px rgba(0, 0, 0, 0.12), 0 2px 2px -1px rgba(0, 0, 0, 0.12), 0 4px 4px -2px rgba(0, 0, 0, 0.12), inset 0 0 2px 1px light-dark(#FFFFFF, rgba(255, 255, 255, 0.08))'

const tabsRootCss: CSSObject = {
	'--rmx-tabs-height': '32px',
	'--rmx-tabs-track-padding': '2px',
	'--rmx-tabs-tab-padding-inline': '12px',
	'--rmx-tabs-tab-shadow': '0 0 0 0 rgba(0, 0, 0, 0)',
	'--rmx-tabs-tab-font-size': '12px',
	'--rmx-tabs-tab-line-height': '17px',
	'--rmx-tabs-gap': '12px',
	boxSizing: 'border-box',
	display: 'grid',
	gap: 'var(--rmx-tabs-gap)',
	minWidth: 0,
}

const tabsListCss: CSSObject = {
	boxSizing: 'border-box',
	display: 'inline-flex',
	alignItems: 'center',
	gap: '2px',
	width: 'max-content',
	maxWidth: '100%',
	minHeight: 'var(--rmx-tabs-height)',
	padding: 'var(--rmx-tabs-track-padding)',
	border: 0,
	borderRadius: '9999px',
	background:
		'linear-gradient(180deg, light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.08)) 0%, rgba(0, 0, 0, 0) 100%), light-dark(#EBEBEB, #2c2c2c)',
	boxShadow:
		'inset 0 0 4px 1px rgba(0, 0, 0, 0.08), inset 0 1px 1px rgba(0, 0, 0, 0.02), inset 0 2px 2px rgba(0, 0, 0, 0.02)',
	overflowX: 'auto',
	scrollbarWidth: 'none',
	'&::-webkit-scrollbar': {
		display: 'none',
	},
	'&[aria-disabled="true"]': {
		opacity: 0.55,
	},
}

const tabsTabCss: CSSObject = {
	'--rmx-tabs-tab-focus-shadow':
		'0 0 0 1px light-dark(#3573F6, #6eaaff), var(--rmx-tabs-tab-shadow), 0 0 0 4px light-dark(rgba(53, 115, 246, 0.1), rgba(110, 170, 255, 0.18)), 0 6px 32px 4px light-dark(rgba(53, 115, 246, 0.08), rgba(110, 170, 255, 0.14)), inset 0 0 8px 1px light-dark(rgba(53, 115, 246, 0.05), rgba(110, 170, 255, 0.1))',
	appearance: 'none',
	margin: 0,
	boxSizing: 'border-box',
	position: 'relative',
	cursor: 'pointer',
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	flexDirection: 'row',
	gap: '4px',
	width: 'max-content',
	maxWidth: '100%',
	minWidth: 0,
	height: 'calc(var(--rmx-tabs-height) - (var(--rmx-tabs-track-padding) * 2))',
	minHeight:
		'calc(var(--rmx-tabs-height) - (var(--rmx-tabs-track-padding) * 2))',
	paddingBlock: 0,
	paddingInline: 'var(--rmx-tabs-tab-padding-inline)',
	border: 0,
	borderRadius: '999px',
	background: 'transparent',
	boxShadow: 'var(--rmx-tabs-tab-shadow)',
	color: 'light-dark(#707070, #b3b3b3)',
	fontFamily: '"Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif',
	fontStyle: 'normal',
	fontWeight: 500,
	fontSize: 'var(--rmx-tabs-tab-font-size)',
	lineHeight: 'var(--rmx-tabs-tab-line-height)',
	fontFeatureSettings: '"ss01" on, "cv01" on',
	letterSpacing: 0,
	textAlign: 'center',
	textDecoration: 'none',
	textShadow: 'none',
	userSelect: 'none',
	WebkitUserSelect: 'none',
	verticalAlign: 'top',
	whiteSpace: 'nowrap',
	'&[data-state="inactive"]:hover:not(:disabled):not([aria-disabled="true"])': {
		background: 'light-dark(rgba(16, 16, 16, 0.05), rgba(236, 236, 236, 0.1))',
		color: 'light-dark(#101010, #ececec)',
	},
	'&[data-state="inactive"]:active:not(:disabled):not([aria-disabled="true"])':
		{
			background:
				'light-dark(rgba(16, 16, 16, 0.08), rgba(236, 236, 236, 0.14))',
		},
	'&[data-state="active"]': {
		background: tabSliderBackground,
		'--rmx-tabs-tab-shadow': tabSliderShadow,
		color: 'light-dark(#101010, #ececec)',
		textShadow: '0 1px 0 light-dark(#FFFFFF, rgb(0 0 0 / 0.35))',
	},
	'&[data-state="active"]:hover:not(:disabled):not([aria-disabled="true"])': {
		background: tabSliderBackground,
	},
	'&[data-state="active"]:active:not(:disabled):not([aria-disabled="true"])': {
		background: tabSliderBackground,
	},
	'&:disabled, &[aria-disabled="true"]': {
		cursor: 'not-allowed',
		opacity: 0.55,
	},
	'&:focus-visible': {
		outline: 0,
		boxShadow: 'var(--rmx-tabs-tab-focus-shadow)',
	},
}

const tabsPanelCss: CSSObject = {
	minWidth: 0,
	color: 'light-dark(#101010, #ececec)',
	fontFamily: '"Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif',
	fontSize: '13px',
	lineHeight: '20px',
	letterSpacing: 0,
	'&[hidden]': {
		display: 'none',
	},
}

const sizeStyles = {
	md: {},
	lg: {
		'--rmx-tabs-height': '36px',
		'--rmx-tabs-tab-padding-inline': '14px',
		'--rmx-tabs-tab-font-size': '13px',
		'--rmx-tabs-tab-line-height': '20px',
		'--rmx-tabs-gap': '14px',
	},
} as const satisfies Record<TabsSize, CSSObject>
