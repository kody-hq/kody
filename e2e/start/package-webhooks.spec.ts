import { randomUUID } from 'node:crypto'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { createPreviewPackage } from '../../tools/control-kody/package-create.ts'
import { readE2eCloudflareMockState } from '../../tools/e2e-cloudflare-mock-state.ts'
import { executeE2eD1Command } from '../d1-utils.ts'
import { requestHasMutationDataFields } from '../server-function-requests.ts'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

async function seedWebhook(packageId: string) {
	// The local Artifacts service stores snapshots, it does not implement Git.
	// Seed a new published snapshot through that service, keeping all real URL
	// mint/reveal/rotate/disable operations and their authorization intact.
	const mock = readE2eCloudflareMockState()
	const url = new URL(
		`/client/v4/accounts/${mock.accountId}/artifacts/namespaces/default/repos/package-${packageId}/mock-source-snapshot`,
		mock.origin,
	)
	const headers = {
		Authorization: `Bearer ${mock.token}`,
		'Content-Type': 'application/json',
	}
	const current = await fetch(url, { headers })
	expect(current.ok).toBe(true)
	const {
		result: { files },
	} = (await current.json()) as { result: { files: Record<string, string> } }
	const manifest = JSON.parse(files['package.json']!)
	manifest.exports = { ...manifest.exports, './launcher': './src/launcher.ts' }
	manifest.kody = {
		...manifest.kody,
		webhooks: [
			{
				name: 'launcher',
				export: './launcher',
				responseMode: 'sync',
				inputMode: 'params',
			},
		],
	}
	const published = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			files: {
				...files,
				'package.json': JSON.stringify(manifest),
				'src/launcher.ts':
					'export default async function launcher() { return { ok: true } }',
			},
		}),
	})
	expect(published.ok).toBe(true)
	const {
		result: { published_commit },
	} = (await published.json()) as { result: { published_commit: string } }
	expect(published_commit).toBeTruthy()
	executeE2eD1Command(
		`UPDATE entity_sources SET published_commit=${quoteSqlString(published_commit)}, indexed_commit=NULL WHERE id=(SELECT source_id FROM saved_packages WHERE id=${quoteSqlString(packageId)});`,
	)
}

test('package webhook URLs mint, reveal, rotate and disable through native Start calls', async ({
	page,
	browser,
	baseURL,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(240_000)
	const id = randomUUID().slice(0, 8)
	const owner = await seedE2eUser({
		email: `webhook-owner-${id}@example.com`,
		username: `webhook-owner-${id}`,
		admin: true,
	})
	const stranger = await seedE2eUser({
		email: `webhook-other-${id}@example.com`,
		username: `webhook-other-${id}`,
	})
	executeE2eD1Command(
		`UPDATE orgs SET plan='standard' WHERE slug=${quoteSqlString(owner.username)};`,
	)
	await login({ ...owner, mode: 'login' })
	const other = await browser.newContext({ baseURL })
	let created: Awaited<ReturnType<typeof createPreviewPackage>> | undefined
	try {
		const signedIn = await other.request.post('/auth', {
			data: { ...stranger, mode: 'login' },
		})
		expect(signedIn.ok()).toBe(true)
		const cookieHeader = (await page.context().cookies(baseURL))
			.map(({ name, value }) => `${name}=${value}`)
			.join('; ')
		created = await createPreviewPackage({
			origin: baseURL!,
			email: owner.email,
			password: owner.password,
			kodyId: `webhooks-${id}`,
			headAhead: false,
			cookieHeader,
		})
		await seedWebhook(created.packageId)
		const settings = `${created.packagePagePath}/settings`
		await page.goto(settings)
		await waitForClientHydration(page)
		const card = page.getByTestId('package-webhook-card').filter({
			has: page.getByRole('heading', { name: 'launcher', exact: true }),
		})
		const url = card.getByTestId('package-webhook-url').locator('pre code')
		await expect(card).toContainText('No URL yet')
		await card.getByTestId('package-webhook-mint').click()
		await expect(url).toBeVisible()
		const original = await url.innerText()
		expect(original).toMatch(/^https?:\/\//)
		await expect(card).toContainText('Needs approval')
		await card.getByTestId('package-webhook-hide-url').click()
		await expect(url).toHaveCount(0)
		const revealing = page.waitForRequest((request) =>
			requestHasMutationDataFields(request, {
				username: owner.username,
				kodyId: created!.kodyId,
				webhookName: 'launcher',
			}),
		)
		await card.getByTestId('package-webhook-reveal').click()
		const revealRequest = await revealing
		await expect(url).toHaveText(original)
		const headers = await revealRequest.allHeaders()
		delete headers.cookie
		delete headers['x-kody-document-actor']
		delete headers['x-kody-document-destination']
		delete headers['content-length']
		const denied = await other.request.post(revealRequest.url(), {
			headers,
			data: revealRequest.postData()!,
		})
		const deniedBody = await denied.text()
		expect(deniedBody).toContain('Package not found.')
		expect(deniedBody).not.toContain(original)
		await page.reload()
		await waitForClientHydration(page)
		await expect(card.getByTestId('package-webhook-reveal')).toBeVisible()
		await expect(url).toHaveCount(0)
		await card.getByRole('button', { name: /^Rotate URL for / }).click()
		await expect(url).toHaveCount(0)
		await card.getByRole('button', { name: /^Confirm rotate URL for / }).click()
		await expect(url).toBeVisible()
		await expect(url).not.toHaveText(original)
		const rotated = await url.innerText()
		await card.getByTestId('package-webhook-approve').click()
		await expect(page.getByTestId('credential-approval-approve')).toBeEnabled()
		await page.getByTestId('credential-approval-approve').click()
		await expect(page.getByTestId('credential-approval-done')).toBeVisible()
		await page.goto(settings)
		await waitForClientHydration(page)
		await expect(card).toContainText('Active')
		const originalEndpoint = (await card.getAttribute('data-webhook-id'))!
			.split('/')
			.at(-1)!
		await card
			.getByTestId('package-webhook-mint-another')
			.locator('summary')
			.click()
		await card.locator('input[name="instanceLabel"]').fill('staging')
		await card.getByTestId('package-webhook-mint-another-submit').click()
		const sibling = page.getByTestId('package-webhook-card').filter({
			has: page.getByRole('heading', {
				name: 'launcher · staging',
				exact: true,
			}),
		})
		await expect(sibling).toContainText('Needs approval')
		await expect(card).toContainText('Active')
		const siblingEndpoint = (await sibling.getAttribute('data-webhook-id'))!
			.split('/')
			.at(-1)!
		expect(siblingEndpoint).not.toBe(originalEndpoint)
		const siblingApproval = sibling.getByTestId('package-webhook-approve')
		const siblingHref = await siblingApproval.getAttribute('href')
		expect(
			new URL(siblingHref!, baseURL).searchParams.getAll('enable'),
		).toEqual([`webhook:launcher:${siblingEndpoint}`])
		await siblingApproval.click()
		await expect(page.getByTestId('credential-approval-approve')).toBeEnabled()
		await page.getByTestId('credential-approval-approve').click()
		await expect(page.getByTestId('credential-approval-done')).toBeVisible()
		await page.goto(settings)
		await waitForClientHydration(page)
		await expect(sibling).toContainText('Active')
		await expect(card).toContainText('Active')
		await sibling.getByRole('button', { name: /^Disable / }).click()
		await sibling.getByRole('button', { name: /^Confirm disable / }).click()
		await expect(sibling).toContainText('Disabled')
		await expect(card).toContainText('Active')
		await card.getByTestId('package-webhook-reveal').click()
		await expect(url).toHaveText(rotated)
		await card.getByRole('button', { name: /^Disable / }).click()
		await expect(card).toContainText('Active')
		await card.getByRole('button', { name: /^Confirm disable / }).click()
		await expect(card).toContainText('Disabled')
		await page.reload()
		await waitForClientHydration(page)
		await expect(card).toContainText('Disabled')
		await expect(card.getByRole('button', { name: /^Enable / })).toBeEnabled()
		await expect(url).toHaveCount(0)
		// Never send a delivery to either URL, these assertions only manage configuration.
	} finally {
		if (created) {
			await page.goto(`${created.packagePagePath}/settings`)
			await waitForClientHydration(page)
			await page.getByTestId('package-delete').click()
			await page.getByTestId('package-delete-confirmation').fill(created.name)
			await page.getByTestId('package-delete-confirm').click()
			await expect(page.getByTestId('package-delete-dialog')).not.toBeVisible()
		}
		await other.close()
	}
})
