# Data ownership and integration

```text
Website
  -> POST /api/public/enquiries
  -> CRM database enquiries (NEW / OPEN / unassigned intake)

School database
  -> super admin and founder authentication
  -> founder directory sync (id, name, email, active)
  -> cluster registry and capacity

CRM database (CRM_DATABASE_URL only)
  -> leads, activities, tasks, next action, demos, proposals
  -> accounts, onboarding operations, automation runs
  -> never falls back to the School database

Cluster school database
  -> schools row with crm_correlation_key
  -> defaults, persons, staff, users, roles
  -> SchoolIMS reads tenant data from the JWT school id

SuperAdmin app
  -> CRM calls stay on EXPO_PUBLIC_SUPERADMIN_API_URL
  -> school and medical calls may follow the selected cluster
```

Three facts stay separate:

1. Pipeline stage and sales outcome.
2. CRM account lifecycle: `LEAD`, `QUALIFIED`, `ONBOARDING`, `ACTIVE`, `AT_RISK`, `CHURNED`.
3. School onboarding status: `pending_build`, `apk_delivered`, `live`, `suspended`.

A won sale can still be onboarding. Creating a school does not mark the account `ACTIVE`. Suspension is not churn. Tenants are identified by `(cluster_id, vertical, external_client_id)`. A numeric school id in another cluster is a different tenant.

SchoolIMS staff do not receive CRM routes, proposals, or sales notes. The school profile route continues to use `req.schoolId` from the authenticated server context.

School prospect import reads `schools` and approved `school_settings` keys into `crm_school_customer_directory`. That table is a CRM projection. It is not a tenant master and it has no cross-database foreign key. Import never writes student, parent, or staff contacts.

