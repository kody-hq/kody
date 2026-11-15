import { http, HttpResponse, type HttpHandler } from 'msw'

type StoredRepo = {
	id: string
	name: string
	description: string | null
	default_branch: string
	created_at: string
	updated_at: string
	last_push_at: string | null
	source: string | null
	read_only: boolean
	remote: string
}

type StoredSnapshot = {
	published_commit: string
	files: Record<string, string>
}

function envelope<T>(result: T, status = 200) {
	return HttpResponse.json(
		{
			success: status >= 200 && status < 300,
			result,
			errors: [],
			messages: [],
		},
		{ status },
	)
}

function errorEnvelope(status: number, code: number, message: string) {
	return HttpResponse.json(
		{
			success: false,
			result: null,
			errors: [{ code, message }],
			messages: [],
		},
		{ status },
	)
}

export function createArtifactsMswHandlers(input: {
	accountId: string
	namespace?: string
	apiBaseUrl: string
}): Array<HttpHandler> {
	const namespace = input.namespace ?? 'default'
	const repos = new Map<string, StoredRepo>()
	const snapshots = new Map<string, StoredSnapshot>()
	const apiOrigin = input.apiBaseUrl.replace(/\/$/, '')
	const namespacePath = `/client/v4/accounts/${input.accountId}/artifacts/namespaces/${namespace}`
	const reposPath = `${namespacePath}/repos`

	return [
		// Like the local Cloudflare API stand-in, remotes live on the API origin
		// and serve no git, so they take the snapshot lane. Git over HTTP fails
		// like a refused connection instead of reaching a real server.
		http.all(`${apiOrigin}/git/*`, () => HttpResponse.error()),
		http.post(`${apiOrigin}${namespacePath}/tokens`, async ({ request }) => {
			const body = (await request.json()) as {
				repo?: string
				scope?: string
				ttl?: number
			}
			const repoName = body.repo?.trim() ?? ''
			if (!repos.has(repoName)) {
				return errorEnvelope(404, 1002, 'repo not found')
			}
			const ttlSeconds = body.ttl ?? 3600
			return envelope({
				id: `tok_${crypto.randomUUID()}`,
				plaintext: `art_v1_${repoName}?expires=${Math.floor(Date.now() / 1000) + ttlSeconds}`,
				scope: body.scope ?? 'write',
				expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
			})
		}),
		http.get(`${apiOrigin}${reposPath}`, () => {
			return envelope([...repos.values()], 200)
		}),
		http.post(`${apiOrigin}${reposPath}`, async ({ request }) => {
			const body = (await request.json()) as {
				name?: string
				description?: string | null
				default_branch?: string
				read_only?: boolean
			}
			const repoName = body.name?.trim() ?? ''
			if (!repoName) {
				return errorEnvelope(400, 1001, 'repo name is required')
			}
			if (repos.has(repoName)) {
				return errorEnvelope(409, 1003, 'repo already exists')
			}
			const now = new Date().toISOString()
			const repo: StoredRepo = {
				id: `repo_${crypto.randomUUID()}`,
				name: repoName,
				description:
					typeof body.description === 'string' ? body.description : null,
				default_branch:
					typeof body.default_branch === 'string' && body.default_branch.trim()
						? body.default_branch.trim()
						: 'main',
				created_at: now,
				updated_at: now,
				last_push_at: null,
				source: null,
				read_only: body.read_only === true,
				remote: `${apiOrigin}/git/${namespace}/${repoName}.git`,
			}
			repos.set(repoName, repo)
			return envelope({
				id: repo.id,
				name: repo.name,
				description: repo.description,
				default_branch: repo.default_branch,
				remote: repo.remote,
				token: `art_v1_${repoName}?expires=${Math.floor(Date.now() / 1000) + 3600}`,
			})
		}),
		http.get(`${apiOrigin}${reposPath}/:repoName`, ({ params }) => {
			const repoName = decodeURIComponent(String(params.repoName))
			const repo = repos.get(repoName)
			if (!repo) {
				return errorEnvelope(404, 1002, 'repo not found')
			}
			return envelope(repo)
		}),
		http.post(
			`${apiOrigin}${reposPath}/:repoName/fork`,
			async ({ params, request }) => {
				const sourceName = decodeURIComponent(String(params.repoName))
				const source = repos.get(sourceName)
				if (!source) {
					return errorEnvelope(404, 1002, 'repo not found')
				}
				const body = (await request.json()) as {
					name?: string
					description?: string | null
					read_only?: boolean
				}
				const targetName = body.name?.trim() ?? ''
				if (!targetName) {
					return errorEnvelope(400, 1001, 'target repo name is required')
				}
				if (repos.has(targetName)) {
					return errorEnvelope(409, 1003, 'repo already exists')
				}
				const now = new Date().toISOString()
				const repo: StoredRepo = {
					id: `repo_${crypto.randomUUID()}`,
					name: targetName,
					description:
						typeof body.description === 'string'
							? body.description
							: source.description,
					default_branch: source.default_branch,
					created_at: now,
					updated_at: now,
					last_push_at: source.last_push_at,
					source: source.name,
					read_only: body.read_only === true,
					remote: `${apiOrigin}/git/${namespace}/${targetName}.git`,
				}
				repos.set(targetName, repo)
				const sourceSnapshot = snapshots.get(sourceName)
				if (sourceSnapshot) {
					snapshots.set(targetName, {
						published_commit: sourceSnapshot.published_commit,
						files: { ...sourceSnapshot.files },
					})
				}
				return envelope({
					id: repo.id,
					name: repo.name,
					description: repo.description,
					default_branch: repo.default_branch,
					remote: repo.remote,
					token: `art_v1_${targetName}?expires=${Math.floor(Date.now() / 1000) + 3600}`,
				})
			},
		),
		http.post(
			`${apiOrigin}${reposPath}/:repoName/mock-source-snapshot`,
			async ({ params, request }) => {
				const repoName = decodeURIComponent(String(params.repoName))
				if (!repos.has(repoName)) {
					return errorEnvelope(404, 1002, 'repo not found')
				}
				const body = (await request.json()) as {
					files?: Record<string, string>
				}
				const files = body.files ?? {}
				const publishedCommit = `commit_${crypto.randomUUID()}`
				snapshots.set(repoName, { published_commit: publishedCommit, files })
				return envelope({
					published_commit: publishedCommit,
					files,
				})
			},
		),
		http.get(
			`${apiOrigin}${reposPath}/:repoName/mock-source-snapshot`,
			({ params, request }) => {
				const repoName = decodeURIComponent(String(params.repoName))
				const snapshot = snapshots.get(repoName)
				if (!snapshot) {
					return errorEnvelope(404, 1002, 'snapshot not found')
				}
				const commit = new URL(request.url).searchParams.get('commit')
				if (commit && commit !== snapshot.published_commit) {
					return errorEnvelope(404, 1002, 'snapshot not found')
				}
				return envelope(snapshot)
			},
		),
	]
}
