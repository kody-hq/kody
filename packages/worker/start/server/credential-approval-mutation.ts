import {
	credentialProposalSchema,
	packageCredentialChangesSchema,
} from '#universal/credential-mutations.ts'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
export const approvePackageCredentials = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			username: z.string().min(1),
			kodyId: z.string().min(1),
			proposal: credentialProposalSchema,
			proposalId: z.string().trim().min(1).nullish(),
			fingerprint: z.string().min(1),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation({}, async ({ env, request, user }) => {
			const { loadPackageMappingScopeForViewer } =
				await import('../../src/app/package-credentials-access.ts')
			const scope = await loadPackageMappingScopeForViewer({
				env,
				request,
				user,
				username: data.username,
				kodyId: data.kodyId,
			})
			if (!scope) throw new Error('Package not found.')
			const { approveCredentialProposal } =
				await import('../../src/credentials/credential-approval.ts')
			const outcome = await approveCredentialProposal({
				scope,
				proposal: data.proposal,
				fingerprint: data.fingerprint,
				proposalId: data.proposalId,
			})
			if (outcome.status === 'approved')
				return { ok: true as const, view: outcome.view }
			return {
				ok: false as const,
				view: outcome.view,
				error:
					outcome.status === 'invalid'
						? 'This proposal has errors to fix before it can be approved.'
						: outcome.status === 'stale'
							? 'Credentials or mappings changed since you reviewed this proposal. Review the updated changes and approve again.'
							: outcome.message,
			}
		})
	})
export const savePackageCredentialMappings = createServerFn({ method: 'POST' })
	.validator(
		packageCredentialChangesSchema.safeExtend({
			username: z.string().min(1),
			kodyId: z.string().min(1),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation({}, async ({ env, request, user }) => {
			const { loadPackageMappingScopeForViewer } =
				await import('../../src/app/package-credentials-access.ts')
			const scope = await loadPackageMappingScopeForViewer({
				env,
				request,
				user,
				username: data.username,
				kodyId: data.kodyId,
			})
			if (!scope) throw new Error('Package not found.')
			const { mutatePackageCredentialMappings } =
				await import('../../src/app/handlers/package-credentials.ts')
			return (
				await mutatePackageCredentialMappings({
					scope,
					body: { changes: data.changes, enablements: data.enablements },
				})
			).data
		})
	})
