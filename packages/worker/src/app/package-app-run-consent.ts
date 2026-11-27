import type {
	OwnerId,
	PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import type { RuntimePackageAppVisitor } from '@kody-internal/shared/runtime-worker.ts'
import {
	packageAppRunConsentRequiredHeader,
	packageAppRunConsentUrl,
} from '#worker/app-visit/run-consent-url.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'

export async function needsPackageAppRunConsent(input: {
	db: D1Database
	packageId: string
	visitor: Pick<RuntimePackageAppVisitor, 'userId' | 'role'> | null
}) {
	const { db, packageId, visitor } = input
	if (!visitor || visitor.role !== null) return false
	// Read from D1 on each outside visit, including visits with a cached access
	// ticket. Removing approval takes effect on the next request.
	const approved = await db
		.prepare(
			'SELECT 1 FROM package_app_run_consents WHERE person_id = ? AND package_id = ?',
		)
		.bind(visitor.userId, packageId)
		.first()
	return approved === null
}

export async function needsPackageAppRunConsentForPerson(input: {
	db: D1Database
	packageId: string | null
	ownerId: OwnerId
	personId: PersonId
}) {
	const { db, packageId, ownerId, personId } = input
	const binding = await loadOrgBindingForOrg(db, personId, ownerId)
	if (!packageId) return !binding?.role
	return needsPackageAppRunConsent({
		db,
		packageId,
		visitor: { userId: personId, role: binding?.role ?? null },
	})
}

export function approvePackageAppRun(
	db: D1Database,
	personId: PersonId,
	packageId: string,
) {
	return db
		.prepare(
			`INSERT INTO package_app_run_consents (person_id, package_id, approved_at)
			 VALUES (?, ?, ?) ON CONFLICT (person_id, package_id) DO NOTHING`,
		)
		.bind(personId, packageId, new Date().toISOString())
		.run()
}

export function removePackageAppRunApproval(
	db: D1Database,
	personId: PersonId,
	packageId: string,
) {
	return db
		.prepare(
			'DELETE FROM package_app_run_consents WHERE person_id = ? AND package_id = ?',
		)
		.bind(personId, packageId)
		.run()
}

export async function listPackageAppRunApprovals(
	db: D1Database,
	personId: PersonId,
) {
	const { results } = await db
		.prepare(
			`SELECT p.id AS packageId, p.name AS name, o.slug AS publisher,
			        COALESCE(NULLIF(trim(o.display_name), ''), o.slug) AS publisherName
			 FROM package_app_run_consents c
			 JOIN saved_packages p ON p.id = c.package_id${andLiveDeletedAtSql('p')}
			 JOIN orgs o ON o.id = p.user_id${andLiveDeletedAtSql('o')}
			 WHERE c.person_id = ?
			 ORDER BY c.approved_at DESC, p.id`,
		)
		.bind(personId)
		.all<{
			packageId: string
			name: string
			publisher: string
			publisherName: string
		}>()
	return results
}

export function packageAppRunConsentResponse(input: {
	request: Request
	baseUrl: string
	packagePath: { username: string; kodyId: string; restPath: string }
	/** True for an agent or smoke-test call: report, never redirect. */
	noRedirect?: boolean
	fromAppHost?: boolean
}) {
	const { request, baseUrl, packagePath } = input
	const headers = {
		'Cache-Control': 'private, no-store',
		[packageAppRunConsentRequiredHeader]: 'required',
	}
	const fetchMode = request.headers.get('Sec-Fetch-Mode')
	const navigation =
		fetchMode === null
			? request.headers.get('Accept')?.includes('text/html')
			: fetchMode === 'navigate'
	if (
		!input.noRedirect &&
		request.method === 'GET' &&
		navigation &&
		!request.headers.has('Upgrade')
	) {
		const location = packageAppRunConsentUrl({
			baseUrl,
			packagePath,
			search: new URL(request.url).search,
			fromAppHost: input.fromAppHost,
		})
		return new Response(null, {
			status: 302,
			headers: {
				...headers,
				Location: location.toString(),
				'Referrer-Policy': 'no-referrer',
			},
		})
	}
	return Response.json(
		{
			error: 'app_run_confirmation_required',
			message:
				'This app needs confirmation before it can run on your Kody account.',
		},
		{ status: 403, headers },
	)
}
