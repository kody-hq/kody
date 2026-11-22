type SentryScope = {
	setLevel(_level: string): void
	setTag(_key: string, _value: string): void
	setFingerprint(_fingerprint: Array<string>): void
	setContext(_key: string, _value: Record<string, unknown>): void
	setUser(_user: Record<string, unknown> | null): void
}

type SentryClient = {
	getOptions(): { dsn?: string }
}

const defaultScope: SentryScope = {
	setLevel() {},
	setTag() {},
	setFingerprint() {},
	setContext() {},
	setUser() {},
}

export function setUser(_user: Record<string, unknown> | null) {}

export function isInitialized() {
	return false
}

export function getClient(): SentryClient | undefined {
	return undefined
}

export function withScope(callback: (scope: SentryScope) => void) {
	callback(defaultScope)
}

export function captureException(_error: unknown) {}

export function captureMessage(_message: string) {}

export function instrumentDurableObjectWithSentry<TClass>(
	_optionsCallback: unknown,
	durableObjectClass: TClass,
) {
	return durableObjectClass
}

export function instrumentWorkflowWithSentry<TClass>(
	_optionsCallback: unknown,
	workflowClass: TClass,
) {
	return workflowClass
}

export async function startSpan<TResult>(
	_options: unknown,
	callback: (span: { setStatus(_status: unknown): void }) => Promise<TResult>,
) {
	return callback({
		setStatus() {},
	})
}

export function getActiveSpan() {
	return undefined
}

export function wrapMcpServerWithSentry<TServer>(
	server: TServer,
	_options?: unknown,
) {
	return server
}

export function withSentry<THandler>(
	_optionsCallback: unknown,
	handler: THandler,
) {
	return handler
}

export function startInactiveSpan(_options: unknown) {
	return {
		setAttribute(_key: string, _value: unknown) {},
		setStatus(_status: unknown) {},
		end(_endTime?: number) {},
	}
}
