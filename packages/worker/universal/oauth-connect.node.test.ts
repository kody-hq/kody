import { expect, test } from 'vitest'
import {
	buildConnectOauthChooserOptions,
	buildConnectOauthHref,
	buildPlatformConnectOauthHref,
	isConnectOauthCallbackUrl,
} from './oauth-connect.ts'

test('connect chooser lists reconnectable connections and hides unused built-ins', () => {
	expect(
		isConnectOauthCallbackUrl(
			new URL('https://example.com/connect/oauth?code=abc&state=1'),
		),
	).toBe(true)
	expect(
		isConnectOauthCallbackUrl(
			new URL('https://example.com/connect/oauth?error=access_denied'),
		),
	).toBe(true)
	expect(
		isConnectOauthCallbackUrl(
			new URL('https://example.com/connect/oauth?provider=google'),
		),
	).toBe(false)

	expect(
		buildConnectOauthHref({ name: 'google-work', appSlug: 'google' }),
	).toBe('/connect/oauth?provider=google-work&app=google')
	expect(
		buildConnectOauthHref({
			name: 'github-platform-2',
			appSlug: 'github-platform',
			platformSlug: 'github-platform',
		}),
	).toBe(
		'/connect/oauth?provider=github-platform-2&app=github-platform&platform=github-platform',
	)
	expect(buildConnectOauthHref({ name: 'github', orgSlug: 'acme' })).toBe(
		'/connect/oauth?provider=github&org=acme',
	)
	expect(buildPlatformConnectOauthHref('notion', 'acme')).toBe(
		'/connect/oauth?provider=notion&platform=notion&org=acme',
	)

	const options = buildConnectOauthChooserOptions({
		orgSlug: 'acme',
		connections: [
			{
				name: 'google-work',
				label: 'Work Google',
				providerKey: 'google',
				logoPath: null,
				autoLogoPath: null,
				catalogLogoPath: '/integrations/provider-marks/google',
				platform: false,
				appSlug: 'google',
				canDrive: true,
			},
			{
				name: 'broken',
				label: 'Broken',
				providerKey: 'linear',
				logoPath: null,
				autoLogoPath: null,
				catalogLogoPath: null,
				platform: false,
				appSlug: 'linear',
				canDrive: false,
			},
			{
				name: 'github',
				label: 'GitHub',
				providerKey: 'github',
				logoPath: '/integrations/logos/github',
				autoLogoPath: null,
				catalogLogoPath: null,
				platform: true,
				appSlug: 'github',
				canDrive: true,
			},
		],
		platformApps: [],
	})

	expect(options.map((option) => option.id)).toEqual([
		'connection:google-work',
		'connection:github',
	])
	expect(options[0]).toMatchObject({
		href: '/connect/oauth?provider=google-work&app=google&org=acme',
		kind: 'connection',
		detail: 'Reconnect your OAuth app',
		catalogLogoPath: '/integrations/provider-marks/google',
	})
	expect(options[1]).toMatchObject({
		href: '/connect/oauth?provider=github&org=acme',
		kind: 'connection',
		detail: 'Set up your own OAuth app to reconnect',
	})
})

const platformApp = (slug: string, provider: string) => ({
	slug,
	label: provider,
	provider,
	logoPath: null,
	catalogLogoPath: `/integrations/provider-marks/${provider}`,
})

test('connect chooser offers published built-ins the user has not connected and reconnects discoverable ones in-lane', () => {
	expect(buildPlatformConnectOauthHref('notion-platform')).toBe(
		'/connect/oauth?provider=notion-platform&platform=notion-platform',
	)

	const options = buildConnectOauthChooserOptions({
		connections: [
			{
				name: 'github',
				label: 'GitHub',
				providerKey: 'github',
				logoPath: null,
				autoLogoPath: null,
				catalogLogoPath: null,
				platform: true,
				platformDiscoverable: true,
				appSlug: 'github-platform',
				canDrive: true,
			},
			{
				name: 'slack-platform',
				label: 'My Slack',
				providerKey: 'slack',
				logoPath: null,
				autoLogoPath: null,
				catalogLogoPath: null,
				platform: false,
				appSlug: 'slack-byo',
				canDrive: true,
			},
		],
		platformApps: [
			platformApp('github-platform', 'github'),
			platformApp('notion-platform', 'notion'),
			platformApp('slack-platform', 'slack'),
		],
	})

	// github-platform is already connected; slack-platform's name is taken.
	expect(options.map((option) => option.id)).toEqual([
		'connection:github',
		'connection:slack-platform',
		'platform:notion-platform',
	])
	expect(options[0]).toMatchObject({
		href: '/connect/oauth?provider=github',
		detail: 'Reconnect this built-in account',
	})
	expect(options[2]).toMatchObject({
		href: '/connect/oauth?provider=notion-platform&platform=notion-platform',
		kind: 'platform',
		detail: "Connect with Kody's built-in app",
		providerKey: 'notion',
	})
})

test('connect chooser offers members their own account through the org app, only with an org', () => {
	const orgApp = {
		slug: 'github',
		label: 'GitHub',
		providerKey: 'github',
		logoPath: null,
		autoLogoPath: null,
		catalogLogoPath: null,
	}
	const [first] = buildConnectOauthChooserOptions({
		orgSlug: 'acme',
		connections: [],
		platformApps: [],
		orgApps: [orgApp],
	})
	expect(first).toMatchObject({
		id: 'org-app:github',
		kind: 'org-app',
		href: '/connect/oauth?provider=github&app=github&org=acme&mode=personal',
		detail: "Connect your own account through this org's app",
	})
	expect(
		buildConnectOauthChooserOptions({
			connections: [],
			platformApps: [],
			orgApps: [orgApp],
		}),
	).toEqual([])
})
