import { seedStableUserIdFromEmail } from '../tools/seed-sql.ts'
import { executeE2eD1Command } from './d1-utils.ts'
import {
	type BrowserContext,
	expect,
	test,
	type Page,
	waitForClientHydration,
} from './playwright-utils.ts'

function sqlString(value: string) {
	return `'${value.replaceAll("'", "''")}'`
}

const noMatch =
	'No pending or approved webhook apply destination matches this link.'

const destinationJson = JSON.stringify({
	method: 'POST',
	url: 'https://hooks.example.invalid/register',
	headers: [{ name: 'Content-Type', value: 'application/json' }],
	body: '{"url":"{{webhookUrl}}"}',
	injectionSites: ['body'],
	auth: 'none',
})

/** Isolated package, endpoint, and pending approvals owned by `ownerId`. */
function seedPendingApprovals(input: {
	ownerId: string
	key: string
	fingerprints: Array<string>
}) {
	const packageId = `pkg-${input.key}`
	const endpointId = `ep-${input.key}`
	executeE2eD1Command(`
INSERT INTO saved_packages (
	id, user_id, name, kody_id, description, tags_json, search_text,
	source_id, has_app, hidden, is_private
) VALUES (
	${sqlString(packageId)}, ${sqlString(input.ownerId)}, ${sqlString(input.key)},
	${sqlString(input.key)}, 'E2E webhook apply package', '[]', ${sqlString(input.key)},
	${sqlString(`src-${input.key}`)}, 0, 0, 1
);
INSERT INTO webhook_endpoints (
	id, user_id, package_id, webhook_name, url_secret_hash, url_secret_encrypted,
	created_at, rotated_at
) VALUES (
	${sqlString(endpointId)}, ${sqlString(input.ownerId)}, ${sqlString(packageId)},
	'incoming', 'e2e-fixture-hash', 'e2e-fixture-ciphertext',
	CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
${input.fingerprints
	.map(
		(fingerprint) => `
INSERT INTO webhook_apply_destination_pending (
	user_id, webhook_endpoint_id, destination_fingerprint, destination_json,
	package_id, webhook_name, created_at, updated_at
) VALUES (
	${sqlString(input.ownerId)}, ${sqlString(endpointId)}, ${sqlString(fingerprint)},
	${sqlString(destinationJson)}, ${sqlString(packageId)}, 'incoming',
	CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);`,
	)
	.join('\n')}
`)
	return `whh_${endpointId}`
}

function approvalPath(input: {
	handle: string
	fingerprint: string
	org?: string
}) {
	const search = new URLSearchParams({
		handle: input.handle,
		fingerprint: input.fingerprint,
	})
	if (input.org) search.set('org', input.org)
	return `/connect/webhook-apply?${search}`
}

async function openApproval(page: Page, path: string) {
	await page.goto(path)
	await waitForClientHydration(page)
}

/**
 * Rewrites strings in the Allow/Reject request the way a forged browser
 * request would, keeping the caller's own document and session.
 */
async function forgeDecision(page: Page, replacements: Record<string, string>) {
	const forged = new Set<string>()
	await page.route('**/_serverFn/**', async (route) => {
		if (
			route.request().method() !== 'POST' ||
			!route.request().postData()?.includes('fingerprint')
		)
			return route.fallback()
		const body = route.request().postDataJSON()
		function rewrite(value: unknown): void {
			if (!value || typeof value !== 'object') return
			const record = value as Record<string, unknown>
			for (const [key, child] of Object.entries(record)) {
				if (typeof child === 'string' && child in replacements) {
					record[key] = replacements[child]
					forged.add(child)
				} else rewrite(child)
			}
		}
		rewrite(body)
		await route.continue({ postData: JSON.stringify(body) })
	})
	return () => Object.keys(replacements).every((from) => forged.has(from))
}

test('team-org webhook apply approval binds the verified org on page load, Allow, and Reject', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 180_000 : 150_000)
	const runId = Date.now()
	const people = {
		owner: await seedE2eUser({
			email: `wha-owner-${runId}@example.com`,
			username: `wha-owner-${runId}`,
			password: 'wha-owner-password',
		}),
		member: await seedE2eUser({
			email: `wha-member-${runId}@example.com`,
			username: `wha-member-${runId}`,
			password: 'wha-member-password',
		}),
		outsider: await seedE2eUser({
			email: `wha-outsider-${runId}@example.com`,
			username: `wha-outsider-${runId}`,
			password: 'wha-outsider-password',
		}),
	}
	const stable = (person: keyof typeof people) =>
		sqlString(seedStableUserIdFromEmail(people[person].email))
	const team = { id: `org-wha-team-${runId}`, slug: `wha-team-${runId}` }
	const other = { id: `org-wha-other-${runId}`, slug: `wha-other-${runId}` }
	const vault = { id: `org-wha-vault-${runId}`, slug: `wha-vault-${runId}` }
	executeE2eD1Command(`
INSERT INTO orgs (id, slug, display_name, created_at, updated_at) VALUES
	(${sqlString(team.id)}, ${sqlString(team.slug)}, 'WHA Team', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
	(${sqlString(other.id)}, ${sqlString(other.slug)}, 'WHA Other', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
	(${sqlString(vault.id)}, ${sqlString(vault.slug)}, 'WHA Vault', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES
	(${sqlString(team.id)}, ${stable('owner')}, 'owner', CURRENT_TIMESTAMP),
	(${sqlString(team.id)}, ${stable('member')}, 'member', CURRENT_TIMESTAMP),
	(${sqlString(other.id)}, ${stable('owner')}, 'owner', CURRENT_TIMESTAMP),
	(${sqlString(vault.id)}, ${stable('outsider')}, 'owner', CURRENT_TIMESTAMP);
`)
	const teamHandle = seedPendingApprovals({
		ownerId: team.id,
		key: `wha-team-${runId}`,
		fingerprints: ['fp-allow', 'fp-reject'],
	})
	const personalHandle = seedPendingApprovals({
		ownerId: seedStableUserIdFromEmail(people.owner.email),
		key: `wha-personal-${runId}`,
		fingerprints: ['fp-personal'],
	})
	const ownLinks = {
		member: {
			handle: seedPendingApprovals({
				ownerId: seedStableUserIdFromEmail(people.member.email),
				key: `wha-member-${runId}`,
				fingerprints: ['fp-member'],
			}),
			fingerprint: 'fp-member',
			org: people.member.username.toLowerCase(),
		},
		outsider: {
			handle: seedPendingApprovals({
				ownerId: seedStableUserIdFromEmail(people.outsider.email),
				key: `wha-outsider-${runId}`,
				fingerprints: ['fp-outsider'],
			}),
			fingerprint: 'fp-outsider',
			org: people.outsider.username.toLowerCase(),
		},
	}
	const allowLink = approvalPath({
		handle: teamHandle,
		fingerprint: 'fp-allow',
		org: team.slug,
	})
	const rejectLink = approvalPath({
		handle: teamHandle,
		fingerprint: 'fp-reject',
		org: team.slug,
	})
	const card = page.getByTestId('connect-webhook-apply-card')
	const errorCard = page.getByTestId('connect-webhook-apply-error')
	const message = page.getByTestId('connect-webhook-apply-message')
	const allow = page.getByTestId('connect-webhook-apply-allow')
	const reject = page.getByTestId('connect-webhook-apply-reject')
	const notFound = page.getByTestId('not-found-page')
	/** Clicks Allow or Reject and returns the decision server function body. */
	async function decide(button: typeof allow) {
		const response = page.waitForResponse(
			(candidate) =>
				candidate.request().method() === 'POST' &&
				new URL(candidate.url()).pathname.startsWith('/_serverFn/') &&
				(candidate.request().postData()?.includes('fingerprint') ?? false),
		)
		await button.click()
		return (await response).text()
	}
	/** Package Write denial: the team rows were found, then refused. */
	function expectWriteDenied(body: string) {
		expect(body).toContain('Missing package:write')
		expect(body).not.toContain(noMatch)
	}
	/** Org binding denial: the session is not a member of the requested org. */
	function expectOrgDenied(body: string) {
		expect(body).toContain('Organization not found')
	}
	function expectNoMatch(body: string) {
		expect(body).toContain(noMatch)
	}

	const cookies: Partial<
		Record<keyof typeof people, Awaited<ReturnType<BrowserContext['cookies']>>>
	> = {}
	for (const person of ['outsider', 'member', 'owner'] as const) {
		await page.context().clearCookies()
		await login({
			email: people[person].email,
			password: people[person].password,
			mode: 'login',
		})
		cookies[person] = await page.context().cookies()
	}
	async function actAs(person: keyof typeof people) {
		await page.context().clearCookies()
		await page.context().addCookies(cookies[person]!)
	}
	async function expectStillPending(link: string) {
		await actAs('owner')
		await openApproval(page, link)
		await expect(card).toBeVisible()
		await expect(allow).toBeVisible()
	}

	// Page load: a non-member and a member without package Write see nothing.
	await actAs('outsider')
	await openApproval(page, allowLink)
	await expect(notFound).toBeVisible()
	await expect(card).toHaveCount(0)
	await expect(page.getByText('fp-allow')).toHaveCount(0)
	await actAs('member')
	await openApproval(page, allowLink)
	await expect(errorCard).toContainText('Missing package:write')
	await expect(card).toHaveCount(0)

	// Page load: the owner's other scopes do not own the team's rows.
	await actAs('owner')
	await openApproval(
		page,
		approvalPath({ handle: teamHandle, fingerprint: 'fp-allow' }),
	)
	await expect(errorCard).toContainText(noMatch)
	await openApproval(
		page,
		approvalPath({
			handle: teamHandle,
			fingerprint: 'fp-allow',
			org: other.slug,
		}),
	)
	await expect(errorCard).toContainText(noMatch)

	// Allow/Reject: a member without Write and a non-member each open their
	// own approval and redirect the decision at the team's pending row.
	for (const [person, button, expectDenied] of [
		['member', allow, expectWriteDenied],
		['member', reject, expectWriteDenied],
		['outsider', allow, expectOrgDenied],
		['outsider', reject, expectOrgDenied],
	] as const) {
		const own = ownLinks[person]
		await actAs(person)
		await openApproval(page, approvalPath(own))
		await expect(allow).toBeVisible()
		const forged = await forgeDecision(page, {
			[own.org]: team.slug,
			[own.handle]: teamHandle,
			[own.fingerprint]: 'fp-allow',
		})
		const body = await decide(button)
		expect(forged()).toBe(true)
		expectDenied(body)
		await page.unrouteAll({ behavior: 'wait' })
		await expectStillPending(allowLink)
	}

	// Allow/Reject: the owner's page cannot be pointed at another org's scope.
	for (const [target, button, expectDenied] of [
		[other.slug, allow, expectNoMatch],
		[other.slug, reject, expectNoMatch],
		[vault.slug, allow, expectOrgDenied],
		[vault.slug, reject, expectOrgDenied],
	] as const) {
		await actAs('owner')
		await openApproval(page, allowLink)
		const forged = await forgeDecision(page, { [team.slug]: target })
		const body = await decide(button)
		expect(forged()).toBe(true)
		expectDenied(body)
		await expect(page.getByText('Destination approved')).toHaveCount(0)
		await page.unrouteAll({ behavior: 'wait' })
		await expectStillPending(allowLink)
	}

	// The owner approves one team destination and rejects another.
	await openApproval(page, allowLink)
	expect(await decide(allow)).not.toContain(noMatch)
	await expect(message).toContainText('Destination approved')
	await openApproval(page, allowLink)
	await expect(card).toContainText('This exact destination is already approved')

	await openApproval(page, rejectLink)
	expect(await decide(reject)).toContain('Approval rejected')
	await expect(errorCard).toContainText('Approval rejected')
	await openApproval(page, rejectLink)
	await expect(errorCard).toContainText(noMatch)

	// Personal org links still work without an org.
	const personalLink = approvalPath({
		handle: personalHandle,
		fingerprint: 'fp-personal',
	})
	await openApproval(page, personalLink)
	await allow.click()
	await expect(message).toContainText('Destination approved')
	await openApproval(page, personalLink)
	await expect(card).toContainText('This exact destination is already approved')
})
