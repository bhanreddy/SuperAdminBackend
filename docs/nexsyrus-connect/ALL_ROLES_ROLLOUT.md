# Connect across all app roles

Connect now supports all 16 SuperAdmin roles, including CA, Lead CA and View-Only Admin. The collaboration menu, route guard, workspace bootstrap, employee search, mentions and direct messages no longer exclude accountants.

The shared authentication middleware permits CA/Lead CA requests to the exact Books and Connect API prefixes. Mandatory password changes, internal-session validation, account suspension and session revocation remain enforced. These roles gain no school, user-administration or other module access.

Migration `33_connect_all_roles.sql` upgrades the installed RLS identity/membership helpers and enrolls all current active internal accounts into the existing NexSyrus workspace. It also enrolls future active accounts and accounts when activated. Membership removals survive logins, profile/role changes, redundant ACTIVE updates and journaled migration reruns. Explicit reactivation or administrator provisioning can restore membership.

Channel creation and company-access management remain Founder/Super Admin controls. Private channels still require membership; DMs are visible only to participants, including when another participant is a Founder. This change does not add school-task permissions or enroll users in private channels.

Validation covers every catalogued role through real internal JWT middleware and PostgreSQL RLS, enrollment/activation, revoked company membership, accountant password-change requirements, API-prefix lookalikes, and frontend route/menu/message behavior. No production messages or test accounts are created for rollout verification.

This rollout supersedes the CA exclusions described in the original implementation audit and initial deployment report.
