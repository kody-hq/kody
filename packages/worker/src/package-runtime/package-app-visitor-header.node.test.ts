import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	packageAppVisitorHeaderName,
	packageAppVisitorHeaderValue,
	withPackageAppVisitorHeader,
} from './package-app-visitor-header.ts'

test('package app visitor header carries trusted consent scopes', () => {
	const header = packageAppVisitorHeaderValue({
		visitor: {
			userId: personIdFromStored('visitor-1'),
			username: 'visitor',
			role: 'member',
		},
		scopes: ['profile', 'email', 'need:calendar'],
	})
	expect(JSON.parse(header ?? 'null')).toEqual({
		userId: personIdFromStored('visitor-1'),
		username: 'visitor',
		role: 'member',
		scopes: ['profile', 'email', 'need:calendar'],
	})
})

test('package app visitor header replaces untrusted incoming metadata', () => {
	const request = new Request('https://apps.example/', {
		headers: { [packageAppVisitorHeaderName]: '{"scopes":["email"]}' },
	})
	const next = withPackageAppVisitorHeader(request, {
		visitor: null,
		identity: {
			userId: personIdFromStored('visitor-2'),
			username: 'visitor',
		},
	})
	expect(
		JSON.parse(next.headers.get(packageAppVisitorHeaderName) ?? 'null'),
	).toMatchObject({
		userId: personIdFromStored('visitor-2'),
		scopes: ['profile'],
	})
})
