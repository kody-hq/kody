/** @jsxImportSource @emotion/react */
import { useRouter } from '@tanstack/react-router'
import { createOAuthCallbackNavigationScope } from '../oauth-callback-navigation.ts'
import { usePageInvalidation } from '../page-invalidation.ts'
import {
	useState,
	useRef,
	useEffect,
	useCallback,
	useMemo,
	type FormEvent,
} from 'react'
import {
	type ConnectOauthExistingConnection,
	type ConnectOauthLoaderData,
} from '#universal/loader-data.ts'

import {
	resolveOauthScopeMenu,
	uniqueOauthScopes,
} from '#universal/oauth-scopes.ts'
import { isConnectOauthCallbackUrl } from '#universal/oauth-connect.ts'

import { readOrgSlugFromUrl } from '#universal/org-binding/url.ts'
import { useShellData } from '../routes/__root.tsx'
import { orgSectionRestPath } from '#universal/org-section-hrefs.ts'
import { organizationsWithSignupFallback } from '#universal/org-pages.ts'

import { ProviderMark } from '../components/provider-icons.tsx'
import {
	pageDescriptionCss,
	pageTitleCss,
} from '#universal/styles/style-primitives.ts'
import {
	renderAdvancedDetails,
	renderRedirectUriCard,
	renderSuccessAdvancedDetails,
} from './connect-oauth-detail.tsx'
import { createConnectOauthDeviceStep } from './connect-oauth-device-step.tsx'
import {
	ConnectOauthCredentialsForm,
	renderConnectStep as ConnectStep,
	renderSuccessCard as SuccessCard,
} from './connect-oauth-forms.tsx'
import {
	connectOauthHeaderDescription,
	connectOauthHeaderTitle,
	renderCallbackPending,
	renderChooser,
	renderIncompleteConfig,
	renderStatusCallout,
	wouldReplaceDifferentApp,
} from './connect-oauth-sections.tsx'
import {
	type ConnectOauthChooserOption,
	type ConnectOauthStatusTone,
	type ConnectOauthStep,
	persistConnectOauthOrgSlug,
	readConnectOauthOrgSlug,
	useConnectOauthOperations,
	connectOauthCallbackHref,
	withConnectOauthChooserOrg,
	buildConnectOauthAuthorizeUrl,
	connectOauthHeaderCss,
	connectOauthEyebrowCss,
	connectOauthPageCss,
	getConnectOauthRedirectUri,
	getConnectOauthStateKey,
	persistConnectOauthConfig,
	readConnectOauthCallback,
	readConnectOauthQueryConfig,
	readStoredConnectOauthConfig,
	validateConnectOauthState,
} from './connect-oauth-shared.ts'
import {
	type ConnectOauthConfig,
	type ConnectOauthNextSteps,
	type StoredIntegrationConfig,
	formatConnectOauthCaughtError,
	formatMissingSetupFields,
	mergeConnectOauthConfig,
	parseConnectOauthNextSteps,
	summarizeStoredSetupState,
	toStoredIntegrationConfig,
} from '#client/routes/connect-oauth-config.ts'

type OauthState = {
	statusMessage: string
	statusTone: ConnectOauthStatusTone
	currentStep: ConnectOauthStep
	config: ConnectOauthConfig | null
	existingIntegrationConfig: StoredIntegrationConfig | null
	accessTokenSaved: boolean
	refreshTokenSaved: boolean
	hasConfigError: boolean
	existingConnection: ConnectOauthExistingConnection | null
	replaceConfirmed: boolean
	chooserOptions: Array<ConnectOauthChooserOption>
	chooserFilter: string
	requestedProvider: string | null
	offeredScopeMenu: Array<string>
	nextSteps: ConnectOauthNextSteps | null
	submitting: boolean
	ssrRedirectUri: string | null
	clientIdInput: string
	clientSecretInput: string
	hasStoredClientId: boolean
	hasStoredClientSecret: boolean
	revealStoredClientSecretField: boolean
}
function initialOauthState(
	routeData: ConnectOauthLoaderData,
	href: string,
): OauthState {
	let statusMessage = 'Loading provider configuration…'
	let statusTone: ConnectOauthStatusTone = 'info'
	let currentStep: ConnectOauthStep = 'setup'
	let config: ConnectOauthConfig | null = null
	let existingIntegrationConfig: StoredIntegrationConfig | null = null
	let accessTokenSaved = false
	let refreshTokenSaved = false
	let hasConfigError = false
	/** The connection currently stored under the target name, when any. */
	let existingConnection: ConnectOauthExistingConnection | null = null
	/** The user explicitly confirmed replacing a different-app connection. */
	let replaceConfirmed = false
	let chooserOptions: Array<ConnectOauthChooserOption> = []
	let chooserFilter = ''
	let requestedProvider: string | null = null
	/**
	 * Scope checkboxes stay on this list while the user unchecks. BYO has no
	 * operator menu, so using live `config.scopes` as the menu would delete
	 * unchecked items (and hide the picker if every box is cleared).
	 */
	let offeredScopeMenu: Array<string> = []
	let nextSteps: ConnectOauthNextSteps | null = null
	let submitting = false
	/**
	 * Normalized pathname+search the current resolution state belongs to.
	 * SPA navigations to a different connect URL (another provider)
	 * reset and re-resolve instead of keeping the previous provider's
	 * config on screen.
	 */
	/** Server-computed redirect URI so SSR renders the card `window` builds. */
	let ssrRedirectUri: string | null = null
	let clientIdInput = ''
	let clientSecretInput = ''
	let hasStoredClientId = false
	let hasStoredClientSecret = false
	let revealStoredClientSecretField = false

	const applySetupState = (nextConfig: ConnectOauthConfig) => {
		clientIdInput = nextConfig.clientId
		clientSecretInput = ''
		hasStoredClientId = Boolean(nextConfig.clientId.trim())
		hasStoredClientSecret =
			nextConfig.hasClientSecret === true || hasStoredClientSecret
		revealStoredClientSecretField = false
		const setupStatus = summarizeStoredSetupState({
			flow: nextConfig.flow,
			clientId: nextConfig.clientId,
			hasStoredClientSecret,
			platform: Boolean(nextConfig.platformAppSlug),
		})
		offeredScopeMenu = resolveOauthScopeMenu({
			allowedScopes: nextConfig.platformAllowedScopes,
			selectedScopes: nextConfig.scopes,
		})
		if (setupStatus.isReady) {
			statusMessage = 'Ready to connect.'
			statusTone = 'info'
			currentStep = 'connect'
			return
		}
		const missingDetails = formatMissingSetupFields(setupStatus.missingFields)
		statusMessage = existingIntegrationConfig
			? `Loaded your existing integration config. ${missingDetails}`
			: missingDetails
		statusTone = 'info'
		currentStep = 'setup'
	}

	const apply = () => {
		const url = new URL(href, 'https://kody.local')
		ssrRedirectUri = routeData.redirectUri ?? null
		existingConnection = routeData.existingConnection ?? null
		chooserOptions = routeData.chooser?.options ?? []
		if (url.searchParams.get('code') || url.searchParams.get('error')) {
			return
		}
		requestedProvider =
			url.searchParams.get('provider')?.trim() || routeData.provider
		if (!requestedProvider) {
			statusMessage = 'Choose a service to connect.'
			statusTone = 'info'
			return
		}
		const parsed = readConnectOauthQueryConfig(url)
		if (!parsed.ok) {
			hasConfigError = true
			statusMessage = parsed.error
			statusTone = 'error'
			return
		}
		const storedIntegration =
			routeData.provider === parsed.value.providerKey && routeData.integration
				? toStoredIntegrationConfig(routeData.integration)
				: null
		existingIntegrationConfig = storedIntegration
		const nextConfig = mergeConnectOauthConfig({
			queryConfig: parsed.value,
			storedIntegration,
		})
		if (!nextConfig) {
			hasConfigError = true
			statusMessage = 'Missing required OAuth configuration parameters.'
			statusTone = 'error'
			return
		}
		config = nextConfig
		hasStoredClientSecret = routeData.hasStoredClientSecret === true
		applySetupState(nextConfig)
	}

	apply()
	return {
		statusMessage,
		statusTone,
		currentStep,
		config,
		existingIntegrationConfig,
		accessTokenSaved,
		refreshTokenSaved,
		hasConfigError,
		existingConnection,
		replaceConfirmed,
		chooserOptions,
		chooserFilter,
		requestedProvider,
		offeredScopeMenu,
		nextSteps,
		submitting,
		ssrRedirectUri,
		clientIdInput,
		clientSecretInput,
		hasStoredClientId,
		hasStoredClientSecret,
		revealStoredClientSecretField,
	}
}
export function ConnectOauthRoute({
	initialData,
	currentHref,
	flowKey,
}: {
	initialData: ConnectOauthLoaderData
	currentHref: string
	flowKey: string
}) {
	const {
		readIntegration,
		readChooser,
		saveApp,
		exchangeCode,
		saveConnection,
	} = useConnectOauthOperations()
	const router = useRouter()
	const [navigationScope] = useState(() =>
		createOAuthCallbackNavigationScope({
			href: currentHref,
			state: router.latestLocation.state,
		}),
	)
	const [flowOrg] = useState(() =>
		readConnectOauthOrgSlug(new URL(currentHref, 'https://kody.local')),
	)
	const { session } = useShellData()
	const organizations = session
		? organizationsWithSignupFallback({
				organizations: session.organizations ?? [],
				username: session.username,
			})
		: []
	const destinationOrg =
		organizations.find((org) => org.slug === flowOrg)?.slug ??
		organizations.find((org) => org.personal)?.slug ??
		organizations[0]?.slug
	const invalidatePages = usePageInvalidation(mutationResources)
	const [state, setState] = useState(() =>
		initialOauthState(
			{
				...initialData,
				chooser: initialData.chooser
					? {
							options: withConnectOauthChooserOrg(
								initialData.chooser.options,
								flowOrg,
							),
						}
					: undefined,
			},
			currentHref,
		),
	)
	const {
		statusMessage,
		statusTone,
		currentStep,
		config,
		existingIntegrationConfig,
		accessTokenSaved,
		refreshTokenSaved,
		hasConfigError,
		existingConnection,
		replaceConfirmed,
		chooserOptions,
		chooserFilter,
		requestedProvider,
		offeredScopeMenu,
		nextSteps,
		submitting,
		ssrRedirectUri,
		clientIdInput,
		clientSecretInput,
		hasStoredClientId,
		hasStoredClientSecret,
		revealStoredClientSecretField,
	} = state
	const mounted = useRef(false),
		inFlight = useRef(false),
		callbackStarted = useRef(false)
	const isFlowActive = useCallback(
		() => mounted.current && navigationScope.isActive(),
		[navigationScope],
	)
	function update(next: Partial<typeof state>) {
		setState((previous) => ({ ...previous, ...next }))
	}
	function setStatus(
		statusMessage: string,
		statusTone: ConnectOauthStatusTone = 'info',
	) {
		update({ statusMessage, statusTone })
	}
	const stateRef = useRef(state)
	useEffect(() => {
		stateRef.current = state
	}, [state])
	const [, setDeviceTick] = useState(0)
	const deviceStep = useMemo(
		() =>
			createConnectOauthDeviceStep({
				getConfig: () => stateRef.current.config,
				getSubmitting: () => stateRef.current.submitting || inFlight.current,
				setSubmitting: (value) => {
					inFlight.current = value
					setState((previous) => ({ ...previous, submitting: value }))
				},
				setStatus: (message, tone = 'info') => {
					setState((previous) => ({
						...previous,
						statusMessage: message,
						statusTone: tone,
					}))
				},
				setStep: (step) => {
					setState((previous) => ({ ...previous, currentStep: step }))
				},
				onSuccess: (result) => {
					setState((previous) => ({
						...previous,
						accessTokenSaved: result.accessTokenSaved,
						refreshTokenSaved: result.refreshTokenSaved,
						nextSteps: result.nextSteps,
					}))
					void invalidatePages()
				},
				update: () => {
					setDeviceTick((tick) => tick + 1)
				},
			}),
		[invalidatePages],
	)
	useEffect(() => () => deviceStep.dispose(), [deviceStep])
	useEffect(() => {
		mounted.current = true
		const unsubscribe = router.subscribe('onBeforeNavigate', ({ toLocation }) =>
			navigationScope.navigate(toLocation),
		)
		return () => {
			mounted.current = false
			unsubscribe()
		}
	}, [router, navigationScope])
	async function handleSetupSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!config || inFlight.current) return
		inFlight.current = true
		update({ submitting: true })
		try {
			const clientId = clientIdInput.trim(),
				clientSecret = clientSecretInput.trim()
			if (!clientId) {
				setStatus('Client ID is required.', 'error')
				return
			}
			if (
				config.flow === 'confidential' &&
				(!hasStoredClientSecret || revealStoredClientSecretField) &&
				!clientSecret
			) {
				setStatus('Client secret is required for confidential flow.', 'error')
				return
			}
			const nextConfig = {
				...config,
				clientId,
				hasClientSecret:
					hasStoredClientSecret ||
					(config.flow === 'confidential' && Boolean(clientSecret)),
			}
			persistConnectOauthOrgSlug(flowOrg)
			const result = await saveApp(
				nextConfig,
				clientSecret || undefined,
				flowOrg,
			)
			if (!result || !isFlowActive()) return
			if (!result.ok) {
				setStatus(result.error, 'error')
				return
			}
			const saved = { ...nextConfig, clientId: result.clientId }
			persistConnectOauthConfig(saved)
			update({
				config: saved,
				hasStoredClientId: true,
				hasStoredClientSecret: saved.hasClientSecret,
				revealStoredClientSecretField: false,
				clientSecretInput: '',
				statusMessage: 'Saved OAuth client configuration.',
				statusTone: 'info',
				currentStep: 'connect',
			})
			void invalidatePages()
		} catch (error) {
			if (isFlowActive())
				setStatus(
					formatConnectOauthCaughtError(
						error,
						'Network error. Please try again.',
					),
					'error',
				)
		} finally {
			inFlight.current = false
			if (isFlowActive()) update({ submitting: false })
		}
	}
	function toggleRequestedScope(scope: string) {
		if (!config) return
		const menu = resolveOauthScopeMenu({
			allowedScopes: config.platformAllowedScopes.length
				? config.platformAllowedScopes
				: offeredScopeMenu,
			selectedScopes: config.scopes,
		})
		if (!menu.includes(scope)) return
		const selected = new Set(config.scopes)
		if (selected.has(scope)) selected.delete(scope)
		else selected.add(scope)
		const nextConfig = {
			...config,
			scopes: uniqueOauthScopes(menu.filter((entry) => selected.has(entry))),
		}
		persistConnectOauthConfig(nextConfig)
		update({ config: nextConfig })
	}
	async function handleConnect() {
		if (!config || inFlight.current) return
		if (config.flow === 'device') {
			await deviceStep.handleDeviceConnect()
			return
		}
		inFlight.current = true
		update({ submitting: true })
		try {
			persistConnectOauthOrgSlug(flowOrg)
			const href = await buildConnectOauthAuthorizeUrl({
				config,
				hasConfigError,
				redirectUri: getConnectOauthRedirectUri(ssrRedirectUri),
			})
			if (isFlowActive()) window.location.assign(href)
		} catch (error) {
			if (isFlowActive())
				setStatus(
					formatConnectOauthCaughtError(error, 'Unable to start OAuth.'),
					'error',
				)
		} finally {
			inFlight.current = false
			if (isFlowActive()) update({ submitting: false })
		}
	}
	useEffect(() => {
		if (callbackStarted.current) return
		const callback = readConnectOauthCallback(
			new URL(currentHref, 'https://kody.local').search,
		)
		if (callback.kind === 'none') {
			persistConnectOauthOrgSlug(
				readOrgSlugFromUrl(new URL(currentHref, window.location.origin)),
			)
			return
		}
		callbackStarted.current = true
		async function complete() {
			try {
				const cleanHref = connectOauthCallbackHref(ssrRedirectUri, flowOrg)
				navigationScope.replace(cleanHref, flowKey)
				await router.navigate({
					href: cleanHref,
					replace: true,
					state: { oauthCallbackFlow: { key: flowKey, href: cleanHref } },
				})
				if (!isFlowActive()) return
				let nextConfig = readStoredConnectOauthConfig()
				if (!nextConfig) {
					const parsed = readConnectOauthQueryConfig(
						new URL(currentHref, window.location.origin),
					)
					if (parsed.ok) {
						const payload = await readIntegration({
							data: {
								orgSlug: flowOrg ?? undefined,
								name: parsed.value.providerKey,
								app:
									new URL(currentHref, window.location.origin).searchParams.get(
										'app',
									) ?? undefined,
							},
						})
						if (!payload || !isFlowActive()) return
						nextConfig = mergeConnectOauthConfig({
							queryConfig: parsed.value,
							storedIntegration: payload.integration
								? toStoredIntegrationConfig(payload.integration)
								: null,
						})
					}
				}
				if (!isFlowActive()) return
				if (!nextConfig) {
					const chooser = await readChooser({
						data: { orgSlug: flowOrg ?? undefined },
					})
					if (!chooser || !isFlowActive()) return
					update({
						chooserOptions: withConnectOauthChooserOrg(
							chooser.options,
							flowOrg,
						),
					})
					update({
						hasConfigError: true,
						statusMessage: 'Missing required OAuth configuration parameters.',
						statusTone: 'error',
					})
					return
				}
				update({ config: nextConfig, currentStep: 'callback' })

				if (callback.kind === 'error') {
					update({
						statusMessage:
							callback.description || `OAuth error: ${callback.error}`,
						statusTone: 'error',
						currentStep: 'connect',
					})
					return
				}
				if (callback.kind !== 'success') return
				if (
					!validateConnectOauthState(
						getConnectOauthStateKey(nextConfig.providerKey),
						callback.state,
					)
				) {
					update({
						statusMessage: 'State mismatch. Restart the OAuth flow.',
						statusTone: 'error',
						currentStep: 'connect',
					})
					return
				}
				const exchange = await exchangeCode(
					nextConfig,
					callback.code,
					getConnectOauthRedirectUri(ssrRedirectUri),
					flowOrg,
				)
				if (!exchange || !isFlowActive()) return
				if (!exchange.ok) {
					update({
						statusMessage: exchange.error,
						statusTone: 'error',
						currentStep:
							exchange.error.includes('client ID') ||
							exchange.error.includes('client secret')
								? 'setup'
								: 'connect',
					})
					return
				}
				const payload = await saveConnection({
					config: nextConfig,
					callbackUrl: window.location.href,
					tokenPayload: exchange.data,
					orgSlug: flowOrg,
				})
				if (!payload || !isFlowActive()) return
				if (!payload.ok) {
					update({
						statusMessage: payload.error,
						statusTone: 'error',
						currentStep: 'connect',
					})
					return
				}
				persistConnectOauthOrgSlug(null)

				update({
					accessTokenSaved: payload.accessTokenSaved === true,
					refreshTokenSaved: payload.refreshTokenSaved === true,
					nextSteps: parseConnectOauthNextSteps(payload.nextSteps),
					statusMessage: 'OAuth tokens saved.',
					statusTone: 'info',
					currentStep: 'success',
				})
				void invalidatePages()
			} catch (error) {
				if (isFlowActive())
					update({
						statusMessage: formatConnectOauthCaughtError(
							error,
							'Network error. Please try again.',
						),
						statusTone: 'error',
						currentStep: 'connect',
					})
			}
		}
		void complete()
	}, [
		readIntegration,
		readChooser,
		exchangeCode,
		saveConnection,
		currentHref,
		invalidatePages,
		ssrRedirectUri,
		flowOrg,
		flowKey,
		router,
		navigationScope,
		isFlowActive,
	])
	const headerInput = {
		config,
		requestedProvider,
		hasConfigError,
		statusTone,
		statusMessage,
		currentStep,
		href: currentHref,
	}
	const description = connectOauthHeaderDescription(headerInput)
	const title = connectOauthHeaderTitle(headerInput)
	if (!config) {
		return (
			<section css={connectOauthPageCss}>
				<header css={connectOauthHeaderCss}>
					<span css={connectOauthEyebrowCss}>Connect an account</span>
					<h1 css={pageTitleCss}>{title}</h1>
					{description ? <p css={pageDescriptionCss}>{description}</p> : null}
				</header>
				{renderStatusCallout({
					statusTone,
					statusMessage,
					currentStep,
					provider: requestedProvider,
					includePrompt: !(requestedProvider && hasConfigError),
				})}
				{requestedProvider && hasConfigError
					? renderIncompleteConfig(requestedProvider)
					: isConnectOauthCallbackUrl(
								new URL(currentHref, 'https://kody.local'),
						  ) && statusTone !== 'error'
						? renderCallbackPending()
						: renderChooser({
								chooserOptions,
								chooserFilter,
								onFilterChange: (value) => {
									update({ chooserFilter: value })
								},
							})}
			</section>
		)
	}
	const currentConfig = config
	return (
		<section css={connectOauthPageCss}>
			<header css={connectOauthHeaderCss}>
				<ProviderMark
					providerKey={currentConfig.providerKey}
					label={currentConfig.provider}
					logoPath={currentConfig.platformLogoPath ?? currentConfig.logoPath}
					autoLogoPath={currentConfig.autoLogoPath}
					catalogLogoPath={currentConfig.catalogLogoPath}
					host={currentConfig.authorizeHost}
				/>
				<span css={connectOauthEyebrowCss}>Connect an account</span>
				<h1 css={pageTitleCss}>{title}</h1>
				{description ? <p css={pageDescriptionCss}>{description}</p> : null}
			</header>
			{renderStatusCallout({
				statusTone,
				statusMessage,
				currentStep,
				provider: currentConfig.provider,
				connectionName: currentConfig.providerKey,
			})}
			{currentStep === 'setup'
				? renderRedirectUriCard({
						config: currentConfig,
						redirectUri: getConnectOauthRedirectUri(ssrRedirectUri),
					})
				: null}
			{currentStep === 'setup' ? (
				<ConnectOauthCredentialsForm
					config={currentConfig}
					existingIntegrationConfig={existingIntegrationConfig}
					hasStoredClientId={hasStoredClientId}
					hasStoredClientSecret={hasStoredClientSecret}
					revealStoredClientSecretField={revealStoredClientSecretField}
					clientIdInput={clientIdInput}
					clientSecretInput={clientSecretInput}
					submitting={submitting}
					onClientIdInput={(value) => {
						update({ clientIdInput: value })
					}}
					onClientSecretInput={(value) => {
						update({ clientSecretInput: value })
					}}
					onRevealStoredClientSecret={() => {
						update({ revealStoredClientSecretField: true })
					}}
					onSubmit={(event) => {
						void handleSetupSubmit(event)
					}}
				/>
			) : null}
			{currentStep === 'connect' ? (
				<ConnectStep
					{...{
						config: currentConfig,
						existingConnection,
						replaceConfirmed,
						submitting,
						offeredScopeMenu,
						onConfirmReplace: () => {
							update({ replaceConfirmed: true })
						},
						onConnect: () => {
							void handleConnect()
						},
						onToggleScope: toggleRequestedScope,
						wouldReplace: wouldReplaceDifferentApp({
							config: currentConfig,
							existingConnection,
						}),
					}}
				/>
			) : null}
			{currentStep === 'device' ? deviceStep.render(currentConfig) : null}
			{currentStep === 'success' ? (
				<SuccessCard
					connectionHref={
						destinationOrg && config
							? orgSectionRestPath(
									destinationOrg,
									'integrations',
									config.providerKey,
								)
							: '/account'
					}
					{...{
						config: currentConfig,
						nextSteps,
					}}
				/>
			) : null}
			{currentStep === 'success'
				? renderSuccessAdvancedDetails({
						config: currentConfig,
						accessTokenSaved,
						refreshTokenSaved,
					})
				: renderAdvancedDetails({
						config: currentConfig,
						existingIntegrationConfig,
					})}
		</section>
	)
}

const mutationResources = [
	'loadIntegrationsPage',
	'loadOnboarding',
	'loadAccountPage',
] as const
