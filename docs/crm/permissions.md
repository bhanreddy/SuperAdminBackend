# CRM role and permission matrix

Identity comes from the School database. CRM `founders` is a shadow directory of `id`, `full_name`, `email`, and `is_active`. It stores no passwords or tokens. Auth user ids and founder ids stay distinct. SuperAdmin syncs the directory, including deactivation.

A non-SuperAdmin with no founder id fails closed with HTTP 403 `SCOPE_REQUIRED`. Null is never platform access. Territory membership does not grant access to another owner's leads. Out-of-scope ids return 404 on both modern and legacy routes. Counts use the same owner filter as rows.

| Action | SuperAdmin | Founder | Approver |
|---|---|---|---|
| List and read own leads, tasks, demos, proposals, documents | Yes, all leads | Own leads only | Own leads, read only |
| Assign or reassign owner | Yes | No | No |
| Move stage, log activity, tasks, demos, proposals, close, reopen | Yes | Own leads | No |
| Convert and start or retry onboarding | Yes | Own won school leads | No |
| Sync activation | Yes | Own linked accounts | No |
| Territory, source, stage, and reason configuration | Yes | No | No |
| Automation rule list and edit | Yes | No | No |
| Founder directory sync | Yes | No | No |
| Upload, map, preview, decide, confirm, retry, or cancel an import | Yes | Own scope only | No |
| Resolve a restricted duplicate | Yes | No | No |
| Archive an imported account through compensation | Yes | No | No |
| Finance approval routes | Yes | No | Yes, existing finance routes only |

Public callers can submit a website enquiry. They cannot list leads or set commercial fields.
