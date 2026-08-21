create table tenants (
  id text primary key,
  display_name text not null,
  created_at timestamptz not null,
  disabled_at timestamptz
);
insert into tenants (id, display_name, created_at) values ('local', 'Compatibility tenant', now());

create table tenant_admin_credentials (
  id uuid primary key,
  tenant_id text not null references tenants(id),
  name text not null,
  token_hash text not null unique,
  created_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index tenant_admin_credentials_tenant_idx on tenant_admin_credentials (tenant_id, created_at desc);

alter table connections add column tenant_id text references tenants(id);
update connections set tenant_id = 'local' where tenant_id is null;
alter table connections alter column tenant_id set not null;
alter table connections drop constraint connections_pkey;
alter table connections add primary key (tenant_id, service, connection_name);

alter table oauth_states add column tenant_id text references tenants(id);
update oauth_states set tenant_id = 'local' where tenant_id is null;
alter table oauth_states alter column tenant_id set not null;

alter table runtime_tokens add column tenant_id text references tenants(id);
update runtime_tokens set tenant_id = 'local' where tenant_id is null;
alter table runtime_tokens alter column tenant_id set not null;
create index runtime_tokens_tenant_idx on runtime_tokens (tenant_id, created_at desc);

alter table runs add column tenant_id text references tenants(id);
update runs set tenant_id = 'local' where tenant_id is null;
alter table runs alter column tenant_id set not null;
create index runs_tenant_started_at_id_idx on runs (tenant_id, started_at desc, id desc);

alter table idempotency_records add column tenant_id text references tenants(id);
update idempotency_records set tenant_id = 'local' where tenant_id is null;
alter table idempotency_records alter column tenant_id set not null;
alter table idempotency_records drop constraint idempotency_records_pkey;
alter table idempotency_records add primary key (tenant_id, key_hash);
