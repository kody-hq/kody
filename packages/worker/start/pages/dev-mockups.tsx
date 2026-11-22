/** @jsxImportSource @emotion/react */
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useExternalInstanceSync } from '../lib/primitives.ts'
import { SiteHeader } from '../components/site-header.tsx'
import { SiteFooter } from '../components/site-footer.tsx'
import { TextLink } from '../components/text-link.tsx'
import { mainGutterPaddingCss } from '../components/app-layout.ts'
import { useShellData } from '../routes/__root.tsx'
import {
	loadMockupModules,
	mockupName,
	type Mockup,
	type MockupShell,
} from '../mockups/mockup.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

type LoadedMockup = { name: string; mockup: Mockup }

function useMockups(names?: ReadonlyArray<string>) {
	const key = names?.join('\n') ?? '*'
	const query = useQuery({
		queryKey: ['dev-mockups', key],
		queryFn: async () => {
			const wanted = key === '*' ? null : key.split('\n')
			const modules = Object.entries(loadMockupModules()).filter(
				([path]) => !wanted || wanted.includes(mockupName(path)),
			)
			const next = await Promise.all(
				modules.map(async ([path, load]) => ({
					name: mockupName(path),
					mockup: (await load()).default,
				})),
			)
			return next.sort((a, b) => a.name.localeCompare(b.name))
		},
		staleTime: Infinity,
		retry: false,
		refetchOnWindowFocus: false,
	})
	const loaded: Array<LoadedMockup> | null = query.data ?? null
	const reason: unknown = query.error
	const error = reason ? String((reason as Error)?.stack ?? reason) : null
	return { loaded, error }
}

/** `/dev/mockups`: every mockup file and its states. */
export function DevMockupsIndexPage() {
	const { loaded, error } = useMockups()
	const { session } = useShellData()
	const workspaceOrg = session?.organizations?.find((org) => org.personal)?.slug
	const hrefFor = (name: string, mockup: Mockup, state?: string) => {
		if (mockup.shell === 'workspace' && !workspaceOrg) return '/login'
		const search = new URLSearchParams()
		if (state) search.set('state', state)
		if (mockup.shell === 'workspace' && mockup.rail)
			search.set('rail', mockup.rail)
		const path =
			mockup.shell === 'workspace'
				? `/@${workspaceOrg}/-/dev-mockups/${name}`
				: `/dev/mockups/${name}`
		return search.size ? `${path}?${search}` : path
	}
	return (
		<main css={indexCss} data-mockups-ready={loaded || error ? '' : undefined}>
			<header css={{ display: 'grid', gap: spacing.xs }}>
				<h1 css={{ margin: 0, fontFamily: typography.fontFamilyDisplay }}>
					Mockups
				</h1>
				<p css={{ margin: 0, color: colors.textMuted }}>
					Proposed UI built from real components. Files are{' '}
					<code>packages/worker/start/mockups/**/*.mockup.tsx</code>. Local dev
					only.
				</p>
			</header>
			{error ? <pre css={errorCss}>{error}</pre> : null}
			{loaded?.length === 0 ? <p>No mockups yet.</p> : null}
			<ul
				css={{
					display: 'grid',
					gap: spacing.md,
					padding: 0,
					listStyle: 'none',
				}}
			>
				{loaded?.map(({ name, mockup }) => (
					<li key={name} css={{ display: 'grid', gap: spacing.xs }}>
						<span css={{ fontWeight: 600 }}>
							<TextLink href={hrefFor(name, mockup)}>{mockup.title}</TextLink>
						</span>
						<span
							css={{
								color: colors.textMuted,
								fontSize: typography.fontSize.sm,
							}}
						>
							<code>{name}</code>
							{mockup.description ? ` · ${mockup.description}` : null}
						</span>
						<span css={{ display: 'flex', flexWrap: 'wrap', gap: spacing.sm }}>
							{Object.keys(mockup.states).map((state) => (
								<TextLink key={state} href={hrefFor(name, mockup, state)}>
									{state}
								</TextLink>
							))}
						</span>
					</li>
				))}
			</ul>
		</main>
	)
}

/** `/dev/mockups/<name>?state=<key>`: one state of one mockup, in its shell. */
export function DevMockupPage({
	name,
	state,
	rail,
	onRail,
}: {
	name: string
	state?: string
	/** Workspace route only: the highlighted rail item and how to change it. */
	rail?: string
	onRail?: (item: NonNullable<Mockup['rail']>) => void
}) {
	const { loaded, error } = useMockups([name])
	const wantedRail = loaded?.[0]?.mockup.rail
	const railPending = Boolean(onRail && wantedRail && wantedRail !== rail)
	useExternalInstanceSync(() => {
		if (railPending && wantedRail) onRail?.(wantedRail)
	}, [railPending, wantedRail, onRail])
	if (error)
		return (
			<pre css={errorCss} data-mockup-ready="">
				{error}
			</pre>
		)
	if (!loaded || railPending) return null
	const entry = loaded[0]
	if (!entry)
		return (
			<pre css={errorCss} data-mockup-ready="">
				{`No mockup named "${name}". Add packages/worker/start/mockups/${name}.mockup.tsx`}
			</pre>
		)
	const states = Object.keys(entry.mockup.states)
	const stateName = state ?? states[0]!
	const render = entry.mockup.states[stateName]
	if (!render)
		return (
			<pre css={errorCss} data-mockup-ready="">
				{`Unknown state "${stateName}". States: ${states.join(', ')}`}
			</pre>
		)
	const shell = entry.mockup.shell ?? 'bare'
	if (shell === 'workspace' && !onRail)
		return (
			<pre
				css={errorCss}
				data-mockup-ready=""
				data-mockup-shell={shell}
				data-mockup-states={states.join(',')}
			>
				{`This mockup uses the workspace shell. Open it from /dev/mockups or at /@<org>/-/dev-mockups/${name}.`}
			</pre>
		)
	return (
		<MockupShellFrame shell={shell}>
			<div
				data-mockup-ready=""
				data-mockup-shell={shell}
				data-mockup-states={states.join(',')}
				css={{ display: 'contents' }}
			>
				{render()}
			</div>
		</MockupShellFrame>
	)
}

/** Mirrors the root layout's header, gutters, and footer for marketing pages. */
function MockupShellFrame({
	shell,
	children,
}: {
	shell: MockupShell
	children: ReactNode
}) {
	const { session } = useShellData()
	if (shell === 'bare' || shell === 'workspace') return <>{children}</>
	return (
		<div
			css={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}
		>
			<SiteHeader
				focused={shell === 'focused'}
				loggedIn={session !== null}
				organizationSession={session}
				displayName={session?.username || session?.email || ''}
				username={session?.username ?? ''}
				avatarUrl={session?.avatarUrl ?? null}
				showAdminLink={session?.roles.includes('admin') ?? false}
				showDemoIndicator={false}
				loginHref="/login"
				currentPathname="/dev/mockups"
			/>
			<div
				css={[
					{ flex: 1, width: '100%', boxSizing: 'border-box' },
					mainGutterPaddingCss,
				]}
			>
				{children}
			</div>
			{shell === 'marketing' ? (
				<SiteFooter
					loggedIn={session !== null}
					loginHref="/login"
					signupHref="/signup"
				/>
			) : null}
		</div>
	)
}

const indexCss = {
	maxWidth: 880,
	margin: '0 auto',
	padding: `${spacing['2xl']} ${spacing.lg}`,
	display: 'grid',
	gap: spacing.lg,
}

const errorCss = {
	margin: spacing.lg,
	padding: spacing.md,
	whiteSpace: 'pre-wrap' as const,
	color: colors.danger,
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.sm,
}
