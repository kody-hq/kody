export function securityProbeFailures(result) {
	const failures = []
	const require = (condition, message) => {
		if (!condition) failures.push(message)
	}
	require(!result.failure, result.failure ?? 'Probe failed')
	require(result.errors.length === 0, 'Uncaught page error')
	require(!result.mixedIdentityFrames
		?.length, 'Mixed shell/profile identity frame')
	if (typeof result.delayed === 'boolean') {
		require(result.protectedApiStatus ===
			401, 'Protected API did not reject logged-out session')
		require(result.afterRefresh?.path ===
			'/login', 'Logout activation did not reach Login')
		require(result.afterRefresh?.profileFieldPresent ===
			0, 'Protected profile field remained after logout')
		require(result.afterRefresh?.draftRetained ===
			false, 'Protected draft remained after logout')
		require(result.afterProtectedNavigation?.path ===
			'/login', 'Protected navigation did not reach Login')
		require(result.afterProtectedNavigation?.jobsSearchPresent ===
			0, 'Protected Jobs UI remained after logout')
		if (result.delayed)
			require(result.capturedLateResponse === true &&
				result.delayedResponseStatus ===
					200, 'Authenticated late response was not exercised')
	} else if (result.name === 'same-context identity switch') {
		require(result.preloadResponses > 0, 'Private preload was not observed')
		require(result.secondUserApiIdentityMatchesFixture === true &&
			result.secondUserProfileStatus ===
				200, 'Second API identity not confirmed')
		require(result.profileMatchesSecondUser === true &&
			result.oldUserVisible ===
				false, 'First profile render retained the prior identity')
		require(result.shellMatchesSecondUser ===
			true, 'Shell did not match second identity')
		require(result.afterSettle?.profileMatchesSecondUser === true &&
			result.afterSettle?.shellMatchesSecondUser ===
				true, 'Settled profile/shell identity mismatch')
		require(result.identityFrames?.some(
			(frame) => frame.shell === 'B' && frame.profile === 'B',
		), 'Second identity frame not observed')
	} else {
		require(result.bCookieConfirmed === true &&
			result.aCookieRestored === true, 'A/B cookie transition not confirmed')
		require(result.preloadResponses?.length >
			0, 'Cookie-switch preload was not observed')
		require(result.profileMatchesOriginalUser === true &&
			result.afterSettleMatchesOriginalUser ===
				true, 'Restored identity profile mismatch')
		require(result.crossSiteReadRpc?.status ===
			403, 'Cross-site read RPC was not observed and blocked')
	}
	return failures
}
