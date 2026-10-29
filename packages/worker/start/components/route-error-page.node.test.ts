import { jsx } from 'react/jsx-runtime'
import { expect, test } from 'vitest'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { PermissionDeniedError } from '#universal/permission-denied.ts'
import { PermissionDeniedPage, RouteErrorPage } from './route-error-page.tsx'

test('permission denials render the 403 explainer with a Grants link', async () => {
	const html = await renderStartPage(
		jsx(PermissionDeniedPage, {
			message: 'Only owners and billing admins can manage billing for @acme.',
			orgSlug: 'acme',
		}),
	)
	expect(html).toContain('data-testid="permission-denied-page"')
	expect(html).toContain('You do not have access to this page')
	expect(html).toContain(
		'Only owners and billing admins can manage billing for @acme.',
	)
	expect(html).toContain('An org Owner can grant access org-wide')
	expect(html).toContain('href="/@acme/-/grants"')
	expect(html).not.toContain('data-testid="internal-error-page"')
})

test('denials outside an org skip the Grants link', async () => {
	const html = await renderStartPage(
		jsx(PermissionDeniedPage, { message: 'No.', orgSlug: null }),
	)
	expect(html).not.toContain('/-/grants')
	expect(html).toContain('Ask an owner for access')
})

test('route boundary keeps the 500 page for unexpected errors', async () => {
	const denied = await renderStartPage(
		jsx(RouteErrorPage, {
			error: new PermissionDeniedError('Missing email:read.'),
		}),
	)
	expect(denied).toContain('data-testid="permission-denied-page"')
	const real = await renderStartPage(
		jsx(RouteErrorPage, { error: new Error('boom') }),
	)
	expect(real).toContain('data-testid="internal-error-page"')
	expect(real).not.toContain('boom')
})
