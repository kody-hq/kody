import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	decidePackageAppBilling,
	resolvePackageAppBilling,
	withRequestBilling,
} from './package-app-billing.ts'

const ownerId = ownerIdFromStored('org-publisher')
const visitorOrgId = ownerIdFromStored('org-visitor')

test('a member of the owning org is billed to the owning org', () => {
	for (const role of ['owner', 'member', 'billing'] as const) {
		expect(
			decidePackageAppBilling({
				ownerId,
				visitor: { role },
				internetVisible: false,
				visitorPersonalOrgId: visitorOrgId,
			}),
		).toBeNull()
	}
})

test('an outside visitor of an internal app is billed to their own org', () => {
	expect(
		decidePackageAppBilling({
			ownerId,
			visitor: { role: null },
			internetVisible: false,
			visitorPersonalOrgId: visitorOrgId,
		}),
	).toEqual({ orgId: visitorOrgId })
})

test('anonymous visitors and every visitor of an internet-visible app bill the publisher', () => {
	expect(
		decidePackageAppBilling({
			ownerId,
			visitor: null,
			internetVisible: true,
			visitorPersonalOrgId: null,
		}),
	).toBeNull()
	expect(
		decidePackageAppBilling({
			ownerId,
			visitor: { role: null },
			internetVisible: true,
			visitorPersonalOrgId: visitorOrgId,
		}),
	).toBeNull()
	expect(
		decidePackageAppBilling({
			ownerId,
			visitor: { role: null },
			internetVisible: false,
			visitorPersonalOrgId: ownerId,
		}),
	).toBeNull()
})

function personalOrgDb(orgId: string | Error) {
	const queries: Array<string> = []
	const db = {
		prepare(sql: string) {
			queries.push(sql)
			return {
				bind: () => ({
					async first() {
						if (orgId instanceof Error) throw orgId
						return { org_id: orgId, org_slug: 'visitor', role: 'owner' }
					},
				}),
			}
		},
	} as unknown as D1Database
	return { db, queries }
}

test('resolvePackageAppBilling looks up the personal org only for an outside visitor of an internal app', async () => {
	const visitor = {
		userId: personIdFromStored('person-visitor'),
		username: 'visitor',
	}
	const member = personalOrgDb(visitorOrgId)
	expect(
		await resolvePackageAppBilling({
			db: member.db,
			ownerId,
			visitor: { ...visitor, role: 'member' },
			internetVisible: false,
		}),
	).toBeNull()
	expect(member.queries).toHaveLength(0)

	const outsider = personalOrgDb(visitorOrgId)
	expect(
		await resolvePackageAppBilling({
			db: outsider.db,
			ownerId,
			visitor: { ...visitor, role: null },
			internetVisible: false,
		}),
	).toEqual({ orgId: visitorOrgId })
	expect(outsider.queries).toHaveLength(1)

	consoleWarn.mockImplementation(() => {})
	const failing = personalOrgDb(new Error('d1 unavailable'))
	expect(
		await resolvePackageAppBilling({
			db: failing.db,
			ownerId,
			visitor: { ...visitor, role: null },
			internetVisible: false,
		}),
	).toBeNull()
	expect(consoleWarn).toHaveBeenCalledWith(
		'package-app-billing-personal-org-lookup-failed',
		expect.any(Error),
	)
})

test('withRequestBilling stamps only a caller context that has a request', () => {
	const request = { org: { id: ownerId, slug: 'publisher' } } as never
	expect(
		withRequestBilling({ request }, { orgId: visitorOrgId }).request,
	).toMatchObject({ billing: { orgId: visitorOrgId } })
	expect(
		withRequestBilling({ request: null }, { orgId: visitorOrgId }),
	).toEqual({ request: null })
	const unchanged = { request }
	expect(withRequestBilling(unchanged, null)).toBe(unchanged)
})
