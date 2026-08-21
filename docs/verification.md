# Verification

Catalog coverage, local execution, and external API verification are separate states.

When documenting a provider, distinguish:

- Catalog-only actions: schemas and metadata are available for discovery.
- Locally executable actions: the open source runtime has an executor for the action.
- Verified coverage: maintainers have current evidence that the action or provider works against the real upstream API.

Do not imply that every catalog action is end-to-end verified unless that evidence is available in
public project artifacts. Prefer verification notes that users can reproduce from this repository,
such as example scripts, smoke tests, or public status pages.

## Shared-Tenant PostgreSQL Acceptance

CI sets `TEST_POSTGRES_URL` to a PostgreSQL 15 service and runs the black-box acceptance scenario in
`src/server/storage/postgres-integration.test.ts`. One PostgreSQL-backed `ConnectApp` serves two
tenant admins and their runtime tokens through tenant management routes, HTTP Action, MCP, proxy,
discovery, transit, cancellation, idempotency, run history, token revocation, foreign connection
denial, and the two-phase OAuth callback/completion protocol. The same `gmail/default` alias is used
by both tenants so passing assertions cannot rely on globally unique aliases.

Provider execution and OAuth token exchange are deterministic in-process fakes: CI cannot depend on
a real Google account or OAuth grant. Transit uses the local filesystem implementation instead of an
external S3/R2 object store. These boundaries do not fake identity or persistence: tenant/admin and
runtime credentials, connections, OAuth state and staged completion, grants, idempotency records,
runs, and revocation all use the same physical PostgreSQL-backed application, while every fake still
asserts the credential or file content selected for the authenticated tenant. Object-store-specific
tenant keying remains covered by the S3, R2, and KV transit store suites.
