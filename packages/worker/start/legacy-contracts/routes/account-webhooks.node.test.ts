import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { AccountWebhooksPage } from '../../pages/account-webhooks.tsx'
import { type SessionInfo } from '../../../client/session.ts'
import {
	type AccountWebhooksLoaderData,
	type PackageWebhookListItem,
} from '#universal/loader-data.ts'

const session: SessionInfo = {
	email: 'jane@example.com',
	emailVerified: true,
	emailVerificationDelivery: null,
	username: 'jane',
	avatarUrl: null,
	roles: [],
	permissions: [],
	featureFlags: {} as SessionInfo['featureFlags'],
}

const unminted: PackageWebhookListItem = {
	id: 'sentry-bridge/sentry',
	packageId: 'pkg-1',
	packageKodyId: 'sentry-bridge',
	packageName: '@jane/sentry-bridge',
	name: 'sentry',
	exportName: './handle-sentry-webhook',
	description: 'Forward Sentry alerts into automations',
	responseMode: 'ack',
	inputMode: 'request',
	rateLimitPerMinute: 60,
	verification: {
		type: 'hmac-sha256',
		header: 'sentry-hook-signature',
		secretName: 'sentryWebhookSecret',
		encoding: 'hex',
	},
	replay: null,
	challenge: null,
	minted: false,
	endpointId: null,
	instanceLabel: null,
	handle: null,
	urlHost: null,
	enabled: null,
	approved: false,
	approvalUrl: null,
	urlRecoverable: false,
	createdAt: null,
	rotatedAt: null,
	previousUrlActiveUntil: null,
}

const minted: PackageWebhookListItem = {
	id: 'raycast/run',
	packageId: 'pkg-2',
	packageKodyId: 'raycast',
	packageName: '@jane/raycast',
	name: 'run',
	exportName: './run',
	description: null,
	responseMode: 'sync',
	inputMode: 'params',
	rateLimitPerMinute: 600,
	verification: null,
	replay: { deliveryIdHeader: 'X-Delivery-Id' },
	challenge: null,
	minted: true,
	endpointId: '11111111-1111-1111-1111-111111111111',
	instanceLabel: null,
	handle: 'whh_11111111-1111-1111-1111-111111111111',
	urlHost: 'kody.example',
	enabled: true,
	approved: true,
	approvalUrl: null,
	urlRecoverable: true,
	createdAt: '2026-09-01T10:00:00.000Z',
	rotatedAt: '2026-09-05T10:00:00.000Z',
	previousUrlActiveUntil: null,
}

async function renderWebhooksPage(
	url: string,
	accountWebhooks: AccountWebhooksLoaderData,
) {
	return renderToString(
		jsx(AccountWebhooksPage, { payload: accountWebhooks, currentHref: url }),
		url,
		session,
	)
}

const payload: AccountWebhooksLoaderData = {
	ok: true,
	username: 'jane',
	webhooks: [minted, unminted],
}

test('webhooks index lists declared webhooks with status and deep-links each row into its package settings card', async () => {
	const html = await renderWebhooksPage('/account/webhooks', payload)

	expect(html).toContain('>Webhooks</h1>')
	expect(html).toContain('aria-label="Webhooks"')
	expect(html).toContain('2 declared · 1 minted')
	expect(html).toContain(
		'href="/@jane/raycast/settings#webhook-run-11111111-1111-1111-1111-111111111111"',
	)
	expect(html).toContain('href="/@jane/sentry-bridge/settings#webhook-sentry"')
	expect(html).toContain('>Active<')
	expect(html).toContain('>No URL yet<')
	expect(html).toContain('URL secret only')
	expect(html).toContain('hmac-sha256 · sentry-hook-signature')
	// The rail marks this page current and the section explainer is the
	// webhooks one; no cold-path loading copy with SSR data.
	expect(html).toMatch(
		/<a(?=[^>]*href="\/@jane\/-\/webhooks")(?=[^>]*aria-current="page")[^>]*>/,
	)
	expect(html).toContain('data-entity-explainer="webhooks"')
	expect(html).not.toContain('Loading webhooks')
	// Credential paths never appear on the index; mint/reveal/rotate live on
	// package settings, which the deep-links above already exercise.
	expect(html).not.toContain('/@jane/webhooks/')
})

test('webhooks index shows the empty state when no package declares a webhook', async () => {
	const html = await renderWebhooksPage('/account/webhooks', {
		...payload,
		webhooks: [],
	})
	expect(html).toContain('0 declared · 0 minted')
	expect(html).toContain('No package on this account declares a webhook yet')
})
