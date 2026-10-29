import { z } from 'zod'
import { orgProfileVisibilities } from './org-public-profile.ts'

export const orgProfileVisibilitySchema = z.enum(orgProfileVisibilities)
