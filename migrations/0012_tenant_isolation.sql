pragma foreign_keys = off;

create table tenants (
  id text primary key,
  display_name text not null,
  created_at text not null,
  disabled_at text
);
insert into tenants (id, display_name, created_at) values ('local', 'Compatibility tenant', datetime('now'));

create table tenant_admin_credentials (
  id text primary key,
  tenant_id text not null references tenants(id),
  name text not null,
  token_hash text not null unique,
  created_at text not null,
  last_used_at text,
  revoked_at text
);
create index tenant_admin_credentials_tenant_idx on tenant_admin_credentials (tenant_id, created_at desc);

alter table connections rename to connections_pre_tenant;
create table connections (
  id text not null unique,
  revision text not null,
  tenant_id text not null references tenants(id),
  service text not null,
  connection_name text not null,
  value text not null,
  updated_at text not null,
  primary key (tenant_id, service, connection_name)
);
insert into connections (id, revision, tenant_id, service, connection_name, value, updated_at)
select id, revision, 'local', service, connection_name, value, updated_at from connections_pre_tenant;
drop table connections_pre_tenant;

alter table oauth_states add column tenant_id text not null default 'local';
alter table runtime_tokens add column tenant_id text not null default 'local';
create index runtime_tokens_tenant_idx on runtime_tokens (tenant_id, created_at desc);
alter table runs add column tenant_id text not null default 'local';
create index runs_tenant_started_at_id_idx on runs (tenant_id, started_at desc, id desc);

alter table idempotency_records rename to idempotency_records_pre_tenant;
create table idempotency_records (
  tenant_id text not null references tenants(id),
  key_hash text not null,
  claim_id text not null,
  request_hash text not null,
  state text not null check (state in ('in_progress', 'completed')),
  response_value text,
  created_at text not null,
  expires_at text not null,
  primary key (tenant_id, key_hash),
  check ((state = 'in_progress' and response_value is null) or (state = 'completed' and response_value is not null))
);
insert into idempotency_records
select 'local', key_hash, claim_id, request_hash, state, response_value, created_at, expires_at
from idempotency_records_pre_tenant;
drop table idempotency_records_pre_tenant;
create index idempotency_records_expires_at_idx on idempotency_records (expires_at);

pragma foreign_keys = on;
