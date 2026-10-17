/** Local-only external profile writes for distinguishing cached and refreshed data. */
export async function profileFixture(context, origin, seedDisplayName) {
	if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
		throw new Error('Fixture writes require a local origin')
	const read = async () => {
		const response = await context.request.get(origin + '/account/profile.json')
		if (!response.ok())
			throw new Error(`Profile fixture read returned ${response.status()}`)
		return response.json()
	}
	const original = await read()
	const write = async (displayName) => {
		const response = await context.request.post(
			origin + '/account/profile.json',
			{ data: { displayName } },
		)
		if (!response.ok() || (await read()).displayName !== displayName)
			throw new Error('Profile fixture write was not persisted')
	}
	try {
		if (typeof seedDisplayName === 'string') await write(seedDisplayName)
	} catch (error) {
		await write(original.displayName)
		throw error
	}
	return {
		write,
		async close() {
			await write(original.displayName)
			return true
		},
	}
}
