// Each restoration gets its own attempt. One failed endpoint must not skip the other.
export async function restoreVideoFixtures(api, original) {
	const result = {
		profileRestored: false,
		retentionRestored: false,
		failures: [],
	}
	try {
		await api('POST', '/account/profile.json', {
			displayName: original.displayName,
		})
		result.profileRestored =
			(await api('GET', '/account/profile.json')).displayName ===
			original.displayName
		if (!result.profileRestored) result.failures.push('profile verification')
	} catch {
		result.failures.push('profile restoration')
	}
	try {
		await api('POST', '/account/jobs.json', {
			action: 'update_retention',
			...original.retention,
		})
		const verified = await api('GET', '/account/jobs.json')
		result.retentionRestored = Object.entries(original.retention).every(
			([key, value]) => verified.retention[key] === value,
		)
		if (!result.retentionRestored)
			result.failures.push('retention verification')
	} catch {
		result.failures.push('retention restoration')
	}
	return result
}
