import { randomUUID } from 'node:crypto'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { createPreviewPackage } from '../../tools/control-kody/package-create.ts'
import { executeE2eD1Command } from '../d1-utils.ts'
import { requestHasMutationDataFields } from '../server-function-requests.ts'
import {
	expect,
	test,
	waitForClientHydration,
	type APIRequestContext,
	type Request,
} from '../playwright-utils.ts'

async function replayAs(request: APIRequestContext, captured: Request) {
	const headers = await captured.allHeaders()
	// Exercise handler authorization using the other account's session, without
	// the owner's document binding intercepting the request first.
	delete headers.cookie
	delete headers['x-kody-document-actor']
	delete headers['x-kody-document-destination']
	delete headers['content-length']
	return request.post(captured.url(), { headers, data: captured.postData()! })
}

test('package settings persist locks and visibility, deny another account, and delete only after confirmation', async ({
	page,
	browser,
	baseURL,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(240_000)
	const id = randomUUID().slice(0, 8)
	const owner = await seedE2eUser({
		email: `settings-owner-${id}@example.com`,
		username: `settings-owner-${id}`,
		admin: true,
	})
	const stranger = await seedE2eUser({
		email: `settings-other-${id}@example.com`,
		username: `settings-other-${id}`,
	})
	executeE2eD1Command(
		`UPDATE orgs SET plan='standard' WHERE slug=${quoteSqlString(owner.username)};`,
	)
	await login({ ...owner, mode: 'login' })
	const other = await browser.newContext({ baseURL })
	const anonymous = await browser.newContext({ baseURL })
	let cleanupPackage: { path: string; name: string } | undefined
	try {
		const signedIn = await other.request.post('/auth', {
			data: { ...stranger, mode: 'login' },
		})
		expect(signedIn.ok(), await signedIn.text()).toBe(true)
		const cookieHeader = (await page.context().cookies(baseURL))
			.map(({ name, value }) => `${name}=${value}`)
			.join('; ')
		const created = await createPreviewPackage({
			origin: baseURL!,
			email: owner.email,
			password: owner.password,
			kodyId: `settings-${id}`,
			description: `Settings mutation fixture ${id}`,
			headAhead: false,
			cookieHeader,
		})
		const path = created.packagePagePath
		cleanupPackage = { path, name: created.name }
		await page.goto(`${path}/settings`)
		await waitForClientHydration(page)
		const lock = page.getByTestId('account-package-lock-toggle')
		await expect(lock).toHaveAttribute('data-locked', 'false')
		const locking = page.waitForRequest((request) =>
			requestHasMutationDataFields(request, { packageId: created.packageId }),
		)
		await lock.click()
		const lockRequest = await locking
		await expect(lock).toHaveAttribute('data-locked', 'true')
		await expect(lock).toBeEnabled()
		await page.reload()
		await waitForClientHydration(page)
		await expect(lock).toHaveAttribute('data-locked', 'true')
		await lock.click()
		await expect(lock).toHaveAttribute('data-locked', 'false')
		await expect(lock).toBeEnabled()
		const deniedLock = await replayAs(other.request, lockRequest)
		expect(deniedLock.status()).toBe(404)
		expect(await deniedLock.text()).toContain('Package not found.')
		await page.reload()
		await waitForClientHydration(page)
		await expect(lock).toHaveAttribute('data-locked', 'false')

		const makePublic = page.getByTestId('package-make-public')
		await page.getByTestId('package-make-public-confirm').fill('wrong-name')
		await makePublic.click()
		await expect(
			page.getByTestId('package-visibility-controls').getByRole('alert'),
		).toContainText('Type')
		expect((await anonymous.request.get(path)).status()).toBe(404)
		await page.getByTestId('package-make-public-confirm').fill(created.kodyId)
		const publishing = page.waitForRequest((request) =>
			requestHasMutationDataFields(request, {
				packageId: created.packageId,
				visibility: 'public',
			}),
		)
		await makePublic.click()
		const publicRequest = await publishing
		await expect(page.getByTestId('package-make-private')).toBeVisible()
		await page.reload()
		await waitForClientHydration(page)
		await expect(page.getByTestId('package-make-private')).toBeVisible()
		expect((await anonymous.request.get(path)).status()).toBe(200)
		await page.getByTestId('package-make-private-confirm').fill(created.kodyId)
		await page.getByTestId('package-make-private').click()
		await expect(page.getByTestId('package-make-public')).toBeVisible()
		const deniedPublic = await replayAs(other.request, publicRequest)
		expect(deniedPublic.status()).toBe(404)
		expect(await deniedPublic.text()).toContain('Package not found.')
		await page.reload()
		await waitForClientHydration(page)
		await expect(page.getByTestId('package-make-public')).toBeVisible()
		expect((await anonymous.request.get(path)).status()).toBe(404)

		await page.getByTestId('package-delete').click()
		await expect(
			page.getByTestId('package-delete-confirmation'),
		).toHaveAttribute('placeholder', created.name)
		await page.getByTestId('package-delete-confirmation').fill('wrong-name')
		await expect(page.getByTestId('package-delete-confirm')).toBeDisabled()
		await page.getByTestId('package-delete-confirmation').fill(created.name)
		let release!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		let capture!: (request: Request) => void
		const captured = new Promise<Request>((resolve) => {
			capture = resolve
		})
		await page.route('**/_serverFn/**', async (route) => {
			if (
				!requestHasMutationDataFields(route.request(), {
					packageId: created.packageId,
					confirmName: created.name,
				})
			)
				return route.fallback()
			capture(route.request())
			await held
			await route.continue()
		})
		try {
			await page.getByTestId('package-delete-confirm').click()
			const deleteRequest = await captured
			const deniedDelete = await replayAs(other.request, deleteRequest)
			expect(deniedDelete.status()).toBe(404)
			expect(await deniedDelete.text()).toContain('Package not found.')
			expect((await page.request.get(`${path}/settings`)).status()).toBe(200)
			release()
			await expect(page).toHaveURL(new RegExp(`/@${owner.username}$`))
			// Fresh requests verify server persistence, independent of Query cache.
			expect((await page.request.get(path)).status()).toBe(404)
			expect((await page.request.get(`${path}/settings`)).status()).toBe(404)
			cleanupPackage = undefined
		} finally {
			release()
			await page.unrouteAll({ behavior: 'wait' })
		}
	} finally {
		if (cleanupPackage) {
			const cleanup = await browser.newContext({
				baseURL,
				storageState: await page.context().storageState(),
			})
			try {
				const cleanupPage = await cleanup.newPage()
				cleanupPage.setDefaultTimeout(10_000)
				const response = await cleanupPage.goto(
					`${cleanupPackage.path}/settings`,
				)
				if (response?.ok()) {
					await waitForClientHydration(cleanupPage)
					await cleanupPage.getByTestId('package-delete').click()
					await cleanupPage
						.getByTestId('package-delete-confirmation')
						.fill(cleanupPackage.name)
					await cleanupPage.getByTestId('package-delete-confirm').click()
					await expect(
						cleanupPage.getByTestId('package-delete-dialog'),
					).not.toBeVisible()
				}
			} catch (error) {
				console.warn('Package settings fixture cleanup failed:', error)
			} finally {
				await cleanup.close()
			}
		}
		await other.close()
		await anonymous.close()
	}
})
