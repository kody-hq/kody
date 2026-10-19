import { createElement, type ComponentProps } from 'react'
import { featureFlagKeys } from '#universal/feature-flags/registry.ts'
import { type SessionInfo } from '#client/session.ts'
import { expect, test } from 'vitest'
import { renderStartPage } from './test-support/render-start-page.ts'
import { ConnectOauthRoute } from './pages/connect-oauth.tsx'
import { AccountIntegrationsPage } from './pages/account-integrations.tsx'
import { AccountSecretsPage } from './pages/account-secrets.tsx'
import { PendingVerificationPage } from './pages/pending-verification.tsx'
import { BlogRoute } from './pages/blog.tsx'
import { BlogPostRoute } from './pages/blog-post.tsx'
import {
	getReadNextBlogPost,
	listBlogPosts,
	toBlogPostSummary,
} from '#worker/blog/catalog.ts'
import { BLOG_PLACEHOLDER_CALLOUT } from '#universal/blog-display.ts'
import {
	type AccountIntegrationListItem,
	type AccountOauthAppListItem,
	type ConnectOauthLoaderData,
	type AccountIntegrationsLoaderData,
	type AccountSecretsLoaderData,
	type BlogLoaderData,
	type BlogPostLoaderData,
} from '#universal/loader-data.ts'

async function renderNative(
	href: string,
	{
		loaderData,
		integrationSelection,
	}: {
		integrationSelection?: ComponentProps<
			typeof AccountIntegrationsPage
		>['selection']
		loaderData: {
			connectOauth?: ConnectOauthLoaderData
			accountIntegrations?: AccountIntegrationsLoaderData
			accountSecrets?: AccountSecretsLoaderData
			blog?: BlogLoaderData
			blogPost?: BlogPostLoaderData
		}
	},
) {
	if (loaderData.accountIntegrations && !integrationSelection)
		throw new Error('Missing integration selection')
	const page = loaderData.connectOauth
		? createElement(ConnectOauthRoute, {
				initialData: loaderData.connectOauth,
				flowKey: 'native-test-flow',
				currentHref: href,
			})
		: loaderData.accountIntegrations
			? createElement(AccountIntegrationsPage, {
					selection: integrationSelection!,
					payload: loaderData.accountIntegrations,
					currentHref: href,
				})
			: loaderData.accountSecrets
				? createElement(AccountSecretsPage, {
						packageApproval: false,
						selection: { selectedId: null, isCreating: false },
						payload: loaderData.accountSecrets,
						currentHref: href,
					})
				: loaderData.blog
					? createElement(BlogRoute, { data: loaderData.blog })
					: loaderData.blogPost
						? createElement(BlogPostRoute, { post: loaderData.blogPost })
						: null
	if (!page) throw new Error('Missing native page fixture')
	return {
		html: await renderStartPage(page, href, {
			email: 'user@example.com',
			username: 'account-user',
			emailVerified: true,
			emailVerificationDelivery: null,
			avatarUrl: null,
			roles: ['user'],
			permissions: [],
			featureFlags: Object.fromEntries(
				featureFlagKeys.map((key) => [key, false]),
			) as SessionInfo['featureFlags'],
		}),
	}
}
function expectHtml(
	html: string,
	present: Array<string>,
	absent: Array<string> = [],
) {
	expect(
		present.filter(
			(snippet) =>
				!html.includes(
					snippet.replaceAll('&', '&amp;').replaceAll("'", '&#x27;'),
				),
		),
	).toEqual([])
	expect(
		absent.filter((snippet) =>
			html.includes(snippet.replaceAll("'", '&#x27;')),
		),
	).toEqual([])
}
test('native pages server-renders connect-oauth provider visits without a loading flash', async () => {
	const redirectUri = 'https://example.com/connect/oauth'
	const googleIntegration = {
		name: 'google',
		appSlug: 'google',
		provider: 'google',
		appLabel: 'Google',
		accountLabel: null,
		tokenUrl: 'https://oauth2.googleapis.com/token',
		apiBaseUrl: 'https://www.googleapis.com',
		flow: 'confidential' as const,
		usePkce: false,
		clientId: 'google-client-id-value',
		hasClientSecret: true,
		requiredHosts: ['oauth2.googleapis.com', 'www.googleapis.com'],
		authorization: {
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			scopes: ['openid', 'email', 'profile'],
			scopeSeparator: null,
			extraAuthorizeParams: { access_type: 'offline' },
		},
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
	const renderConnect = async (
		path: string,
		connectOauth: Omit<ConnectOauthLoaderData, 'ok' | 'redirectUri'>,
	) => {
		const page = await renderNative(`/connect/oauth${path}`, {
			loaderData: { connectOauth: { ok: true, redirectUri, ...connectOauth } },
		})
		return page.html
	}
	const noIntegration = {
		integration: null,
		builtInAvailable: false,
		hasStoredClientSecret: false,
	}

	// A stored user-lane confidential google connection whose client secret
	// already exists: the page must SSR straight into "ready to connect"
	// with the Redirect URI card, not "Loading provider configuration…".
	expectHtml(
		await renderConnect('?provider=google', {
			provider: 'google',
			integration: googleIntegration,
			builtInAvailable: false,
			hasStoredClientSecret: true,
		}),
		[
			'data-testid="provider-mark"',
			'data-testid="connect-oauth-advanced"',
			'data-testid="connect-oauth-scopes"',
			'https://accounts.google.com/o/oauth2/v2/auth',
		],
	)

	// Reconnecting a platform connection is bring-your-own setup: the page
	// asks for the user's client credentials instead of one-click authorize.
	expectHtml(
		await renderConnect('?provider=google', {
			provider: 'google',
			integration: {
				...googleIntegration,
				usePkce: true,
				clientId: '',
				hasClientSecret: false,
				requiredHosts: ['oauth2.googleapis.com'],
				authorization: {
					...googleIntegration.authorization,
					scopes: ['openid'],
					extraAuthorizeParams: {},
				},
			},
			builtInAvailable: false,
			existingConnection: { lane: 'platform', appSlug: 'google' },
			hasStoredClientSecret: false,
		}),
		['Paste the client ID', redirectUri],
	)

	// First-time bring-your-own setup: credentials form and redirect URL are
	// visible; endpoints and allowed hosts stay behind the disclosure.
	expectHtml(
		await renderConnect(
			'?provider=github&authorizeUrl=https%3A%2F%2Fgithub.com%2Flogin%2Foauth%2Fauthorize&tokenUrl=https%3A%2F%2Fgithub.com%2Flogin%2Foauth%2Faccess_token',
			{ provider: 'github', ...noIntegration },
		),
		[
			redirectUri,
			'data-testid="connect-oauth-advanced"',
			'https://github.com/login/oauth/authorize',
		],
	)

	// Provider without stored or query endpoints: the missing-config error
	// is a single alert, not also repeated as the header description.
	const missingHtml = await renderConnect('?provider=unknown-provider', {
		provider: 'unknown-provider',
		...noIntegration,
	})
	expectHtml(missingHtml, [
		'role="alert"',
		'data-testid="connect-oauth-incomplete"',
		'data-error-agent-prompt',
		'Copy prompt for your agent',
	])
	expect(
		missingHtml.split('Missing required OAuth configuration parameters.')
			.length - 1,
	).toBe(1)

	expect(missingHtml.match(/data-error-agent-prompt=/g)).toHaveLength(1)

	// The chooser only adds a filter once it lists more than six options.
	const chooserOptions = [
		'google',
		'github',
		'slack',
		'discord',
		'notion',
		'spotify',
		'linear',
	].map((slug) => ({
		id: `connection:${slug}`,
		href: `/connect/oauth?provider=${slug}&app=${slug}`,
		label: slug,
		detail: 'Reconnect your OAuth app',
		providerKey: slug,
		logoPath: null,
		autoLogoPath: null,
		catalogLogoPath: null,
		kind: 'connection' as const,
	}))
	const renderChooser = (options: typeof chooserOptions, path = '') =>
		renderConnect(path, {
			provider: null,
			integration: null,
			chooser: { options },
		})
	const list = 'data-testid="connect-oauth-chooser-list"'
	const filter = 'data-testid="connect-oauth-chooser-filter"'
	expectHtml(
		await renderChooser(chooserOptions.slice(0, 1)),
		[
			'data-testid="connect-oauth-chooser"',
			list,
			'/connect/oauth?provider=google&app=google',
		],
		[filter],
	)
	expectHtml(await renderChooser(chooserOptions.slice(0, 6)), [list], [filter])
	expectHtml(await renderChooser(chooserOptions), [
		filter,
		list,
		'/connect/oauth?provider=linear&app=linear',
	])

	expectHtml(
		await renderChooser([], '?code=auth-code&state=abc'),
		['data-testid="connect-oauth-callback"'],
		['data-testid="connect-oauth-chooser"'],
	)
})

test('native pages server-renders simplified integration and secret-approval pages', async () => {
	const googleConnection = {
		name: 'google',
		appSlug: 'google',
		provider: 'google',
		appLabel: 'Google',
		accountLabel: 'me@example.com',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		apiBaseUrl: 'https://www.googleapis.com',
		flow: 'confidential' as const,
		usePkce: false,
		clientId: 'google-client-id-value',
		hasClientSecret: true,
		requiredHosts: ['oauth2.googleapis.com', 'www.googleapis.com'],
		authorization: {
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			scopes: ['openid', 'email', 'profile'],
			scopeSeparator: null,
			extraAuthorizeParams: { access_type: 'offline' },
		},
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
	const googleApp = {
		slug: 'google',
		provider: 'google',
		label: 'Google',
		clientId: 'google-client-id-value',
		hasClientSecret: true,
		tokenUrl: 'https://oauth2.googleapis.com/token',
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		deviceAuthorizationUrl: null,
		apiBaseUrl: 'https://www.googleapis.com',
		flow: 'confidential' as const,
		usePkce: false,
		tokenExchangeStyle: null,
		scopeSeparator: null,
		extraAuthorizeParams: {},
		connectionCount: 1,
		connections: [{ name: 'google', accountLabel: 'me@example.com' }],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
	const renderIntegrations = async (
		path: string,
		selection: ComponentProps<typeof AccountIntegrationsPage>['selection'],
		integrations: Array<AccountIntegrationListItem> = [googleConnection],
		apps: Array<AccountOauthAppListItem> = [googleApp],
	) => {
		const page = await renderNative(`/@account-user/-/integrations${path}`, {
			integrationSelection: selection,
			loaderData: {
				accountIntegrations: {
					ok: true,
					email: 'user@example.com',
					username: 'account-user',
					integrations,
					apps,
				},
			},
		})
		return page.html
	}

	const connectionHtml = await renderIntegrations('/google', {
		kind: 'connection',
		connectionName: 'google',
	})

	expectHtml(
		connectionHtml,
		[
			'1 account connected.',
			'data-testid="add-account-open"',
			'href="/@account-user/-/integrations/google?add-account=1#add-account"',
			'>Reconnect<',
			'data-testid="provider-mark"',
			'data-testid="integration-advanced"',
			'data-testid="integration-connection"',
			'data-highlighted="true"',
			'aria-label="Integrations"',
		],
		['data-testid="add-account-form"'],
	)

	expectHtml(
		await renderIntegrations('/apps/google', {
			kind: 'app',
			appSlug: 'google',
		}),
		[
			'1 account connected.',
			'data-testid="integration-advanced"',
			'Rotate credentials',
		],
		['data-highlighted="true"', 'data-testid="built-in-indicator"'],
	)

	const builtInConnection = { ...googleConnection, platform: true }
	const builtInHtml = await renderIntegrations(
		'/google',
		{ kind: 'connection', connectionName: 'google' },
		[
			builtInConnection,
			{
				...builtInConnection,
				name: 'google-work',
				accountLabel: 'work@example.com',
				authorization: null,
			},
		],
		[
			{
				...googleApp,
				platform: true,
				hasClientSecret: false,
				connectionCount: 2,
				connections: [
					{ name: 'google', accountLabel: 'me@example.com' },
					{ name: 'google-work', accountLabel: 'work@example.com' },
				],
			},
		],
	)
	expectHtml(
		builtInHtml,
		[
			'data-testid="built-in-indicator"',
			'2 accounts connected.',
			'data-testid="add-account-open"',
			'Needs setup',
			'>Connect<',
			'/connect/oauth?provider=google-work',
		],
		['data-testid="add-account-form"', 'Rotate credentials'],
	)

	expectHtml(
		await renderIntegrations('/google?add-account=1#add-account', {
			kind: 'connection',
			connectionName: 'google',
		}),
		['data-testid="add-account-form"', 'id="add-account"', 'value="google-2"'],
		['data-testid="add-account-open"'],
	)
	expect(
		await renderIntegrations('/missing-connection', {
			kind: 'connection',
			connectionName: 'missing-connection',
		}),
	).toContain('data-testid="connection-not-found"')
	expect(
		await renderIntegrations('/apps/missing-app', {
			kind: 'app',
			appSlug: 'missing-app',
		}),
	).toContain('data-testid="integration-not-found"')
	expect(await renderIntegrations('', { kind: 'list' }, [], [])).toContain(
		'No integrations yet.',
	)

	const secret = {
		id: 'user:googleAccessToken',
		name: 'googleAccessToken',
		scope: 'user' as const,
		description: '',
		packageId: null,
		packageTitle: null,
		allowedHosts: ['oauth2.googleapis.com'],
		allowedPackages: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		expiresAt: null,
		ttlMs: null,
		placement: null,
	}
	const approval = await renderNative(
		'/@account-user/-/secrets/user/googleAccessToken?allowed-host=gmail.googleapis.com',
		{
			loaderData: {
				accountSecrets: {
					ok: true,
					email: 'user@example.com',
					packageOptions: [],
					packages: [],
					secrets: [secret],
					selectedSecret: { ...secret, value: 'redacted' },
					approval: {
						name: 'googleAccessToken',
						names: ['googleAccessToken'],
						scope: 'user',
						requestedHost: 'gmail.googleapis.com',
						requestedHosts: ['gmail.googleapis.com'],
						rejectedHosts: [],
						requestedPackageId: null,
						currentAllowedHosts: ['oauth2.googleapis.com'],
						currentAllowedPackages: [],
					},
					approvalError: null,
				},
			},
		},
	)
	expectHtml(approval.html, [
		'Allow access',
		'gmail.googleapis.com',
		'data-testid="secret-approval-advanced"',
	])
})

test('native pages renders the blog index and posts with placeholder or reviewed artwork', async () => {
	const posts = listBlogPosts().map(toBlogPostSummary)
	expect(posts.length).toBeGreaterThan(0)
	const index = await renderNative('/blog', {
		loaderData: { blog: { ok: true, posts } },
	})
	expectHtml(
		index.html,
		posts.map((post) => `href="/blog/${post.slug}"`),
	)

	const renderPost = async (slug: string) => {
		const post = listBlogPosts().find((candidate) => candidate.slug === slug)
		if (!post) throw new Error(`Missing blog post ${slug}`)
		const readNext = getReadNextBlogPost(slug)
		const page = await renderNative(`/blog/${slug}`, {
			loaderData: {
				blogPost: {
					ok: true,
					slug,
					title: post.title,
					date: post.date,
					description: post.description,
					placeholder: post.placeholder,
					image: post.image,
					imageAlt: post.imageAlt,
					ogImage: post.ogImage,
					body: post.body,
					readNext,
				},
			},
		})
		return { post, readNext, html: page.html }
	}

	// A real catalog post whose own title and read-next title carry no
	// apostrophes (JSX escaping would rewrite them in the HTML output).
	// Markdown body renders in the prose voice: authored `##` stays h2 (not
	// the README demotion to h4).
	const placeholder = await renderPost('every-install-is-a-fork-you-own')
	expect(placeholder.readNext).not.toBeNull()
	expectHtml(placeholder.html, [
		'href="/blog"',
		`href="/blog/${placeholder.readNext!.slug}"`,
		BLOG_PLACEHOLDER_CALLOUT,
	])
	expect(placeholder.html).toMatch(/<h2[^>]*>/)
	expect(placeholder.html).not.toMatch(/<h4[^>]*>/)

	const reviewed = await renderPost('early-kody-users')
	expect(reviewed.post.placeholder).toBe(false)
	expectHtml(reviewed.html, [], [BLOG_PLACEHOLDER_CALLOUT])

	const withArt = await renderPost('openclaw-2-needs-a-home')
	expect(withArt.post.image).toBe('/images/openclaw-2-needs-a-home.webp')
	expect(withArt.post.ogImage).toBe('/images/openclaw-2-needs-a-home-og.jpg')
	expectHtml(withArt.html, ['src="/images/openclaw-2-needs-a-home.webp"'])
})

test('native pending verification renders its recovery illustration and email', async () => {
	const html = await renderStartPage(
		createElement(PendingVerificationPage, {
			data: {
				ok: true,
				email: 'user@example.com',
				emailVerificationDelivery: null,
			},
		}),
		'/pending-verification',
	)
	expect(html).toContain('src="/images/kody-envelope.png"')
	expect(html).toContain('data-testid="pending-verification-page"')
	expect(html).toContain('user@example.com')
})
