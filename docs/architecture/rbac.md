# Role-based access control

OmniCrawl currently defines three application roles:

- `USER`: manage their own runs, schedules and private actors; use public actors.
- `ADMIN`: all `USER` capabilities plus list, create, activate, suspend, promote,
  demote and adjust credits for user accounts.
- `SUPER_ADMIN`: highest administrative role. Only another `SUPER_ADMIN` can
  grant or modify this role.

`User.status` is either `ACTIVE` or `SUSPENDED`. Authentication middleware
loads the current user from PostgreSQL for every request, so role and status
changes take effect immediately even when an older JWT is still valid.

Administrative endpoints:

- `GET /api/admin/users`
- `POST /api/admin/users`
- `PATCH /api/admin/users/:id`

Safety rules prevent an administrator from changing their own role or
suspending their own account, ensure at least one active administrator remains,
and ensure at least one active super administrator remains once that role is in
use.
