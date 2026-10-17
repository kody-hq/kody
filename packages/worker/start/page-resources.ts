/** Loader names only. Type imports do not pull server functions into the client. */
import type * as account_collections from '#start/server/account-collections'
import type * as account_page from '#start/server/account-page'
import type * as account_security from '#start/server/account-security'
import type * as action_page from '#start/server/action-page'
import type * as admin_codemods from '#start/server/admin-codemods'
import type * as admin_community_reports from '#start/server/admin-community-reports'
import type * as admin_feature_flags from '#start/server/admin-feature-flags'
import type * as admin_insights from '#start/server/admin-insights'
import type * as admin_platform_feedback from '#start/server/admin-platform-feedback'
import type * as admin_platform_integrations from '#start/server/admin-platform-integrations'
import type * as admin_provider_marks from '#start/server/admin-provider-marks'
import type * as admin_reserved_usernames from '#start/server/admin-reserved-usernames'
import type * as admin_roles from '#start/server/admin-roles'
import type * as admin_system_email from '#start/server/admin-system-email'
import type * as admin_users from '#start/server/admin-users'
import type * as auth_page from '#start/server/auth-page'
import type * as billing_completion from '#start/server/billing-completion'
import type * as blog from '#start/server/blog'
import type * as connect from '#start/server/connect'
import type * as discord from '#start/server/discord'
import type * as docs from '#start/server/docs'
import type * as error_page from '#start/server/error-page'
import type * as home from '#start/server/home'
import type * as oauth from '#start/server/oauth'
import type * as onboarding from '#start/server/onboarding'
import type * as package_alias from '#start/server/package-alias'
import type * as package_files from '#start/server/package-files'
import type * as package_review from '#start/server/package-review'
import type * as pending_verification from '#start/server/pending-verification'
import type * as public_data from '#start/server/public-data'
import type * as shell from '#start/server/shell'
import type * as static_page from '#start/server/static-page'
import type * as verify from '#start/server/verify'

import type * as credentials from '#start/server/credentials'
import type * as connection_usage from '#start/server/connection-usage'

export type PageResource =
	| keyof typeof connection_usage
	| keyof typeof credentials
	| keyof typeof account_collections
	| keyof typeof account_page
	| keyof typeof account_security
	| keyof typeof action_page
	| keyof typeof admin_codemods
	| keyof typeof admin_community_reports
	| keyof typeof admin_feature_flags
	| keyof typeof admin_insights
	| keyof typeof admin_platform_feedback
	| keyof typeof admin_platform_integrations
	| keyof typeof admin_provider_marks
	| keyof typeof admin_reserved_usernames
	| keyof typeof admin_roles
	| keyof typeof admin_system_email
	| keyof typeof admin_users
	| keyof typeof auth_page
	| keyof typeof billing_completion
	| keyof typeof blog
	| keyof typeof connect
	| keyof typeof discord
	| keyof typeof docs
	| keyof typeof error_page
	| keyof typeof home
	| keyof typeof oauth
	| keyof typeof onboarding
	| keyof typeof package_alias
	| keyof typeof package_files
	| keyof typeof package_review
	| keyof typeof pending_verification
	| keyof typeof public_data
	| keyof typeof shell
	| keyof typeof static_page
	| keyof typeof verify
