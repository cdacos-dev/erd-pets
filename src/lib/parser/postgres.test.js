import { describe, it, expect } from 'vitest';
import { tokenize, TokenStream } from './tokenizer.js';
import { parsePostgresSQL, generateForeignKeySql, removeForeignKeyStatement, addPrimaryKeyColumn, removePrimaryKeyColumn, findOrphanedAlterTables, removeOrphanedAlterTables } from './postgres.js';

describe('tokenizer', () => {
	it('tokenizes simple SQL', () => {
		const tokens = tokenize('CREATE TABLE users (id integer);');
		const types = tokens.map((t) => t.type);

		expect(types).toContain('KEYWORD');
		expect(types).toContain('IDENTIFIER');
		expect(types).toContain('PUNCTUATION');
		expect(types[types.length - 1]).toBe('EOF');
	});

	it('handles quoted identifiers', () => {
		const tokens = tokenize('SELECT "Grant" FROM users');

		const quoted = tokens.find((t) => t.type === 'QUOTED_IDENTIFIER');
		expect(quoted).toBeDefined();
		expect(quoted?.value).toBe('Grant');
	});

	it('folds unquoted identifiers to lowercase', () => {
		const tokens = tokenize('SELECT UserName FROM Users');

		const identifiers = tokens.filter((t) => t.type === 'IDENTIFIER');
		expect(identifiers.map((t) => t.value)).toEqual(['username', 'users']);
	});

	it('handles line comments', () => {
		const tokens = tokenize('SELECT -- this is a comment\n* FROM users');

		// Comment should be skipped
		const types = tokens.map((t) => t.type);
		expect(types).not.toContain('COMMENT');
	});

	it('handles block comments', () => {
		const tokens = tokenize('SELECT /* block\ncomment */ * FROM users');

		const types = tokens.map((t) => t.type);
		expect(types).not.toContain('COMMENT');
	});

	it('tracks line numbers', () => {
		const tokens = tokenize('CREATE\nTABLE\nusers');

		expect(tokens[0].line).toBe(1); // CREATE
		expect(tokens[1].line).toBe(2); // TABLE
		expect(tokens[2].line).toBe(3); // users
	});

	it('handles string literals', () => {
		const tokens = tokenize("SELECT 'hello world' FROM users");

		const str = tokens.find((t) => t.type === 'STRING');
		expect(str).toBeDefined();
		expect(str?.value).toBe('hello world');
	});

	it('handles operators', () => {
		const tokens = tokenize("SELECT * FROM users WHERE id = 1 AND name::text <> ''");

		const operators = tokens.filter((t) => t.type === 'OPERATOR');
		expect(operators.map((t) => t.value)).toContain('::');
		expect(operators.map((t) => t.value)).toContain('<>');
	});
});

describe('TokenStream', () => {
	it('provides peek and next operations', () => {
		const tokens = tokenize('CREATE TABLE');
		const stream = new TokenStream(tokens);

		expect(stream.peek().value).toBe('CREATE');
		expect(stream.next().value).toBe('CREATE');
		expect(stream.peek().value).toBe('TABLE');
	});

	it('supports save and restore', () => {
		const tokens = tokenize('CREATE TABLE users');
		const stream = new TokenStream(tokens);

		const saved = stream.save();
		stream.next();
		stream.next();
		expect(stream.peek().value).toBe('users');

		stream.restore(saved);
		expect(stream.peek().value).toBe('CREATE');
	});

	it('matches tokens conditionally', () => {
		const tokens = tokenize('CREATE TABLE');
		const stream = new TokenStream(tokens);

		expect(stream.match('KEYWORD', 'SELECT')).toBeNull();
		expect(stream.match('KEYWORD', 'CREATE')).not.toBeNull();
		expect(stream.peek().value).toBe('TABLE');
	});
});

describe('parsePostgresSQL', () => {
	it('parses a simple table', () => {
		const sql = `
      CREATE TABLE users (
        id integer,
        name text
      );
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables).toHaveLength(1);
		expect(result.tables[0].schema).toBe('public');
		expect(result.tables[0].name).toBe('users');
		expect(result.tables[0].columns).toHaveLength(2);
		expect(result.tables[0].columns[0]).toEqual({
			name: 'id',
			type: 'integer',
			isPrimaryKey: false
		});
		expect(result.tables[0].columns[1]).toEqual({
			name: 'name',
			type: 'text',
			isPrimaryKey: false
		});
	});

	it('parses schema-qualified table names', () => {
		const sql = `CREATE TABLE myschema.users (id integer);`;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].schema).toBe('myschema');
		expect(result.tables[0].name).toBe('users');
		expect(result.tables[0].qualifiedName).toBe('myschema.users');
	});

	it('handles quoted identifiers', () => {
		const sql = `CREATE TABLE contract."grant" (id integer);`;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].schema).toBe('contract');
		expect(result.tables[0].name).toBe('grant');
		expect(result.tables[0].qualifiedName).toBe('contract.grant');
	});

	it('parses multi-word types (timestamp with time zone)', () => {
		const sql = `
      CREATE TABLE events (
        created_at timestamp with time zone
      );
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns[0].type).toBe('timestamp with time zone');
	});

	it('parses character varying type', () => {
		const sql = `
      CREATE TABLE users (
        name character varying
      );
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns[0].type).toBe('character varying');
	});

	it('parses types with length specifiers', () => {
		const sql = `
      CREATE TABLE users (
        name varchar(255),
        code char(2)
      );
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns[0].type).toBe('varchar(255)');
		expect(result.tables[0].columns[1].type).toBe('char(2)');
	});

	it('parses array types', () => {
		const sql = `
      CREATE TABLE regions (
        codes varchar(5)[]
      );
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns[0].type).toBe('varchar(5)[]');
	});

	it('parses integer array types', () => {
		const sql = `
      CREATE TABLE data (
        values integer[]
      );
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns[0].type).toBe('integer[]');
	});

	it('handles columns with NOT NULL', () => {
		const sql = `
      CREATE TABLE users (
        id integer not null,
        name text
      );
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns[0].type).toBe('integer');
		expect(result.tables[0].columns[1].type).toBe('text');
	});

	it('handles columns with DEFAULT', () => {
		const sql = `
      CREATE TABLE users (
        created_at timestamp with time zone default now(),
        active boolean default true
      );
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns[0].type).toBe('timestamp with time zone');
		expect(result.tables[0].columns[1].type).toBe('boolean');
	});

	it('handles GENERATED ALWAYS AS IDENTITY', () => {
		const sql = `
      CREATE TABLE users (
        id integer generated always as identity
      );
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns[0].type).toBe('integer');
	});

	it('handles bigint with GENERATED ALWAYS AS IDENTITY', () => {
		const sql = `
      CREATE TABLE assets (
        id bigint generated always as identity
      );
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns[0].type).toBe('bigint');
	});

	it('handles complex DEFAULT expressions', () => {
		const sql = `
      CREATE TABLE users (
        metadata jsonb default '{}'::jsonb not null
      );
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns[0].type).toBe('jsonb');
	});

	it('resolves primary keys via ALTER TABLE', () => {
		const sql = `
      CREATE TABLE users (
        id integer,
        name text
      );
      ALTER TABLE users ADD PRIMARY KEY (id);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns[0].isPrimaryKey).toBe(true);
		expect(result.tables[0].columns[1].isPrimaryKey).toBe(false);
	});

	it('resolves primary keys for schema-qualified tables', () => {
		const sql = `
      CREATE TABLE myschema.users (
        id integer,
        name text
      );
      ALTER TABLE myschema.users ADD PRIMARY KEY (id);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns[0].isPrimaryKey).toBe(true);
	});

	it('resolves primary keys for quoted identifiers', () => {
		const sql = `
      CREATE TABLE contract."grant" (
        id integer,
        name text
      );
      ALTER TABLE contract."grant" ADD PRIMARY KEY (id);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns[0].isPrimaryKey).toBe(true);
	});

	it('parses multiple tables', () => {
		const sql = `
      CREATE TABLE users (id integer);
      CREATE TABLE posts (id integer, user_id integer);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables).toHaveLength(2);
		expect(result.tables[0].name).toBe('users');
		expect(result.tables[1].name).toBe('posts');
	});

	it('ignores non-table statements', () => {
		const sql = `
      CREATE SCHEMA myschema;
      CREATE TABLE users (id integer);
      ALTER SYSTEM SET timezone = 'UTC';
      SELECT pg_reload_conf();
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables).toHaveLength(1);
		expect(result.tables[0].name).toBe('users');
	});

	it('recovers from parse errors', () => {
		const sql = `
      CREATE TABLE broken (
        id integer,,,,
      );
      CREATE TABLE valid (id integer);
    `;

		const result = parsePostgresSQL(sql);

		// Should still parse the valid table
		expect(result.tables.some((t) => t.name === 'valid')).toBe(true);
	});

	it('handles timestamptz alias', () => {
		const sql = `
      CREATE TABLE events (
        created_at timestamptz
      );
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns[0].type).toBe('timestamptz');
	});

	it('handles IF NOT EXISTS', () => {
		const sql = `
      CREATE TABLE IF NOT EXISTS users (id integer);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables).toHaveLength(1);
		expect(result.tables[0].name).toBe('users');
	});

	it('recognizes table-level PRIMARY KEY and skips other constraints', () => {
		const sql = `
      CREATE TABLE users (
        id integer,
        name text,
        PRIMARY KEY (id),
        UNIQUE (name)
      );
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns).toHaveLength(2);
		expect(result.tables[0].columns[0].name).toBe('id');
		expect(result.tables[0].columns[0].isPrimaryKey).toBe(true);
		expect(result.tables[0].columns[1].name).toBe('name');
		expect(result.tables[0].columns[1].isPrimaryKey).toBe(false);
	});

	it('recognizes named table-level CONSTRAINT ... PRIMARY KEY with quoted column', () => {
		const sql = `
      CREATE TABLE assertion_fact (
        "id" integer,
        value text,
        CONSTRAINT assertion_fact_pkey PRIMARY KEY ("id")
      );
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns).toHaveLength(2);
		expect(result.tables[0].columns[0].name).toBe('id');
		expect(result.tables[0].columns[0].isPrimaryKey).toBe(true);
		expect(result.tables[0].columns[1].isPrimaryKey).toBe(false);
	});

	it('recognizes compound table-level PRIMARY KEY', () => {
		const sql = `
      CREATE TABLE membership (
        user_id integer,
        group_id integer,
        joined_at timestamp,
        CONSTRAINT membership_pkey PRIMARY KEY (user_id, group_id)
      );
    `;

		const result = parsePostgresSQL(sql);

		const cols = result.tables[0].columns;
		expect(cols.find((c) => c.name === 'user_id')?.isPrimaryKey).toBe(true);
		expect(cols.find((c) => c.name === 'group_id')?.isPrimaryKey).toBe(true);
		expect(cols.find((c) => c.name === 'joined_at')?.isPrimaryKey).toBe(false);
	});
});

describe('parsePostgresSQL foreign keys', () => {
	it('parses a simple foreign key with explicit target column', () => {
		const sql = `
      CREATE TABLE users (id integer, name text);
      CREATE TABLE posts (id integer, user_id integer);
      ALTER TABLE users ADD PRIMARY KEY (id);
      ALTER TABLE posts ADD PRIMARY KEY (id);
      ALTER TABLE posts ADD FOREIGN KEY (user_id) REFERENCES users (id);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(1);
		expect(result.foreignKeys[0]).toEqual({
			sourceTable: 'public.posts',
			sourceColumn: 'user_id',
			targetTable: 'public.users',
			targetColumn: 'id'
		});
	});

	it('resolves target column to PK when not specified', () => {
		const sql = `
      CREATE TABLE users (id integer, name text);
      CREATE TABLE posts (id integer, user_id integer);
      ALTER TABLE users ADD PRIMARY KEY (id);
      ALTER TABLE posts ADD PRIMARY KEY (id);
      ALTER TABLE posts ADD FOREIGN KEY (user_id) REFERENCES users;
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(1);
		expect(result.foreignKeys[0]).toEqual({
			sourceTable: 'public.posts',
			sourceColumn: 'user_id',
			targetTable: 'public.users',
			targetColumn: 'id'
		});
	});

	it('reports error when target has no PK and column not specified', () => {
		const sql = `
      CREATE TABLE users (id integer, name text);
      CREATE TABLE posts (id integer, user_id integer);
      ALTER TABLE posts ADD FOREIGN KEY (user_id) REFERENCES users;
    `;

		const result = parsePostgresSQL(sql);

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].message).toContain('public.users');
		expect(result.errors[0].message).toContain('no primary key');
	});

	it('parses schema-qualified foreign keys', () => {
		const sql = `
      CREATE TABLE contract.contract_type (id integer);
      CREATE TABLE contract.contract (id integer, contract_type_id integer);
      ALTER TABLE contract.contract_type ADD PRIMARY KEY (id);
      ALTER TABLE contract.contract ADD PRIMARY KEY (id);
      ALTER TABLE contract.contract ADD FOREIGN KEY (contract_type_id) REFERENCES contract.contract_type;
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(1);
		expect(result.foreignKeys[0]).toEqual({
			sourceTable: 'contract.contract',
			sourceColumn: 'contract_type_id',
			targetTable: 'contract.contract_type',
			targetColumn: 'id'
		});
	});

	it('parses foreign keys with quoted identifiers', () => {
		const sql = `
      CREATE TABLE contract.grant_capacity (id integer);
      CREATE TABLE contract."grant" (id integer, grant_capacity_id integer);
      ALTER TABLE contract.grant_capacity ADD PRIMARY KEY (id);
      ALTER TABLE contract."grant" ADD PRIMARY KEY (id);
      ALTER TABLE contract."grant" ADD FOREIGN KEY (grant_capacity_id) REFERENCES contract.grant_capacity;
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(1);
		expect(result.foreignKeys[0]).toEqual({
			sourceTable: 'contract.grant',
			sourceColumn: 'grant_capacity_id',
			targetTable: 'contract.grant_capacity',
			targetColumn: 'id'
		});
	});

	it('parses multiple foreign keys from same table', () => {
		const sql = `
      CREATE TABLE contract.contract_type (id integer);
      CREATE TABLE contract.state_type (id integer);
      CREATE TABLE contract.scope (id integer, contract_id integer, state_type_id integer);
      ALTER TABLE contract.contract_type ADD PRIMARY KEY (id);
      ALTER TABLE contract.state_type ADD PRIMARY KEY (id);
      ALTER TABLE contract.scope ADD PRIMARY KEY (id);
      ALTER TABLE contract.scope ADD FOREIGN KEY (contract_id) REFERENCES contract.contract_type;
      ALTER TABLE contract.scope ADD FOREIGN KEY (state_type_id) REFERENCES contract.state_type;
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(2);
		expect(result.foreignKeys[0].sourceColumn).toBe('contract_id');
		expect(result.foreignKeys[1].sourceColumn).toBe('state_type_id');
	});

	it('parses foreign keys with named constraints', () => {
		const sql = `
      CREATE TABLE users (id integer);
      CREATE TABLE posts (id integer, user_id integer);
      ALTER TABLE users ADD PRIMARY KEY (id);
      ALTER TABLE posts ADD CONSTRAINT fk_posts_user FOREIGN KEY (user_id) REFERENCES users (id);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(1);
		expect(result.foreignKeys[0].sourceColumn).toBe('user_id');
	});

	it('parses cross-schema foreign keys', () => {
		const sql = `
      CREATE TABLE asset.asset (id bigint);
      CREATE TABLE contract.manifest_asset (id integer, asset_id bigint);
      ALTER TABLE asset.asset ADD PRIMARY KEY (id);
      ALTER TABLE contract.manifest_asset ADD PRIMARY KEY (id);
      ALTER TABLE contract.manifest_asset ADD FOREIGN KEY (asset_id) REFERENCES asset.asset;
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(1);
		expect(result.foreignKeys[0]).toEqual({
			sourceTable: 'contract.manifest_asset',
			sourceColumn: 'asset_id',
			targetTable: 'asset.asset',
			targetColumn: 'id'
		});
	});

	it('parses ALTER TABLE ONLY (pg_dump output) for primary keys and foreign keys', () => {
		const sql = `
      CREATE TABLE system.auth_user (id integer);
      CREATE TABLE contract.manifest_asset (id integer, updated_by integer);
      ALTER TABLE ONLY system.auth_user ADD CONSTRAINT auth_user_pkey PRIMARY KEY (id);
      ALTER TABLE ONLY contract.manifest_asset ADD CONSTRAINT manifest_asset_pkey PRIMARY KEY (id);
      ALTER TABLE ONLY "contract"."manifest_asset" ADD CONSTRAINT "manifest_asset_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "system"."auth_user" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
    `;

		const result = parsePostgresSQL(sql);

		expect(result.errors).toEqual([]);
		expect(result.foreignKeys).toHaveLength(1);
		expect(result.foreignKeys[0]).toEqual({
			sourceTable: 'contract.manifest_asset',
			sourceColumn: 'updated_by',
			targetTable: 'system.auth_user',
			targetColumn: 'id'
		});
	});

	it('parses ALTER TABLE IF EXISTS ONLY combination', () => {
		const sql = `
      CREATE TABLE users (id integer);
      CREATE TABLE posts (id integer, user_id integer);
      ALTER TABLE IF EXISTS ONLY users ADD PRIMARY KEY (id);
      ALTER TABLE IF EXISTS ONLY posts ADD FOREIGN KEY (user_id) REFERENCES users (id);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(1);
		expect(result.foreignKeys[0]).toEqual({
			sourceTable: 'public.posts',
			sourceColumn: 'user_id',
			targetTable: 'public.users',
			targetColumn: 'id'
		});
	});

	it('returns empty foreignKeys array when no FKs defined', () => {
		const sql = `
      CREATE TABLE users (id integer);
      ALTER TABLE users ADD PRIMARY KEY (id);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toEqual([]);
	});

	it('creates FK even when target table not found (external reference)', () => {
		const sql = `
      CREATE TABLE posts (id integer, user_id integer);
      ALTER TABLE posts ADD FOREIGN KEY (user_id) REFERENCES external.users (id);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(1);
		expect(result.foreignKeys[0]).toEqual({
			sourceTable: 'public.posts',
			sourceColumn: 'user_id',
			targetTable: 'external.users',
			targetColumn: 'id'
		});
		expect(result.errors).toHaveLength(0);
	});
});

describe('parsePostgresSQL inline REFERENCES', () => {
	it('parses inline foreign key with explicit target column', () => {
		const sql = `
      CREATE TABLE users (id integer);
      CREATE TABLE posts (id integer, user_id integer REFERENCES users(id));
      ALTER TABLE users ADD PRIMARY KEY (id);
      ALTER TABLE posts ADD PRIMARY KEY (id);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(1);
		expect(result.foreignKeys[0]).toEqual({
			sourceTable: 'public.posts',
			sourceColumn: 'user_id',
			targetTable: 'public.users',
			targetColumn: 'id'
		});
	});

	it('parses inline foreign key with NOT NULL modifier', () => {
		const sql = `
      CREATE TABLE users (id integer);
      CREATE TABLE posts (id integer, user_id integer NOT NULL REFERENCES users(id));
      ALTER TABLE users ADD PRIMARY KEY (id);
      ALTER TABLE posts ADD PRIMARY KEY (id);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(1);
		expect(result.foreignKeys[0]).toEqual({
			sourceTable: 'public.posts',
			sourceColumn: 'user_id',
			targetTable: 'public.users',
			targetColumn: 'id'
		});
	});

	it('resolves target column to PK when not specified (inline)', () => {
		const sql = `
      CREATE TABLE users (id integer);
      ALTER TABLE users ADD PRIMARY KEY (id);
      CREATE TABLE posts (id integer, user_id integer REFERENCES users);
      ALTER TABLE posts ADD PRIMARY KEY (id);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(1);
		expect(result.foreignKeys[0]).toEqual({
			sourceTable: 'public.posts',
			sourceColumn: 'user_id',
			targetTable: 'public.users',
			targetColumn: 'id'
		});
	});

	it('resolves forward reference target column via post-processing', () => {
		const sql = `
      CREATE TABLE posts (id integer, user_id integer REFERENCES users);
      CREATE TABLE users (id integer);
      ALTER TABLE users ADD PRIMARY KEY (id);
      ALTER TABLE posts ADD PRIMARY KEY (id);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(1);
		expect(result.foreignKeys[0]).toEqual({
			sourceTable: 'public.posts',
			sourceColumn: 'user_id',
			targetTable: 'public.users',
			targetColumn: 'id'
		});
	});

	it('parses schema-qualified inline foreign keys', () => {
		const sql = `
      CREATE TABLE contract.contract_type (id integer);
      ALTER TABLE contract.contract_type ADD PRIMARY KEY (id);
      CREATE TABLE contract.contract (id integer, contract_type_id integer NOT NULL REFERENCES contract.contract_type(id));
      ALTER TABLE contract.contract ADD PRIMARY KEY (id);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(1);
		expect(result.foreignKeys[0]).toEqual({
			sourceTable: 'contract.contract',
			sourceColumn: 'contract_type_id',
			targetTable: 'contract.contract_type',
			targetColumn: 'id'
		});
	});

	it('parses multiple inline foreign keys in same table', () => {
		const sql = `
      CREATE TABLE users (id integer);
      CREATE TABLE categories (id integer);
      ALTER TABLE users ADD PRIMARY KEY (id);
      ALTER TABLE categories ADD PRIMARY KEY (id);
      CREATE TABLE posts (
        id integer,
        user_id integer REFERENCES users(id),
        category_id integer REFERENCES categories(id)
      );
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(2);
		expect(result.foreignKeys[0].sourceColumn).toBe('user_id');
		expect(result.foreignKeys[0].targetTable).toBe('public.users');
		expect(result.foreignKeys[1].sourceColumn).toBe('category_id');
		expect(result.foreignKeys[1].targetTable).toBe('public.categories');
	});

	it('handles mix of inline and ALTER TABLE foreign keys', () => {
		const sql = `
      CREATE TABLE users (id integer);
      CREATE TABLE categories (id integer);
      ALTER TABLE users ADD PRIMARY KEY (id);
      ALTER TABLE categories ADD PRIMARY KEY (id);
      CREATE TABLE posts (
        id integer,
        user_id integer REFERENCES users(id),
        category_id integer
      );
      ALTER TABLE posts ADD FOREIGN KEY (category_id) REFERENCES categories(id);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(2);
		expect(result.foreignKeys[0].sourceColumn).toBe('user_id');
		expect(result.foreignKeys[1].sourceColumn).toBe('category_id');
	});

	it('creates FK even when target table not found (external reference, inline)', () => {
		const sql = `
      CREATE TABLE posts (id integer, user_id integer REFERENCES external.users(id));
    `;

		const result = parsePostgresSQL(sql);

		expect(result.foreignKeys).toHaveLength(1);
		expect(result.foreignKeys[0]).toEqual({
			sourceTable: 'public.posts',
			sourceColumn: 'user_id',
			targetTable: 'external.users',
			targetColumn: 'id'
		});
		expect(result.errors).toHaveLength(0);
	});
});

describe('parsePostgresSQL with contracts.sql patterns', () => {
	it('parses all foreign keys from contracts.sql pattern', () => {
		const sql = `
      CREATE TABLE asset.asset (id bigint);
      CREATE TABLE contract.contract (id integer, contract_type_id integer);
      CREATE TABLE contract.contract_type (id integer);
      CREATE TABLE contract."grant" (id integer, grant_capacity_id integer, grant_type_id integer);
      CREATE TABLE contract.grant_capacity (id integer);
      CREATE TABLE contract.grant_type (id integer);
      CREATE TABLE contract.manifest (id integer);
      CREATE TABLE contract.manifest_asset (id integer, manifest_id integer, asset_id bigint);
      CREATE TABLE contract.scope (id integer, contract_id integer, state_type_id integer);
      CREATE TABLE contract.state_type (id integer);
      CREATE TABLE contract.date_type (id integer);
      CREATE TABLE contract.scope_date (id integer, date_type_id integer, scope_id integer);
      CREATE TABLE contract.scope_grant (id integer, scope_id integer, grant_id integer);
      CREATE TABLE contract.scope_manifest (id integer, scope_id integer, manifest_id integer);
      CREATE TABLE contract.region (id integer);
      CREATE TABLE contract.scope_region (id integer, region_id integer, scope_id integer);

      ALTER TABLE asset.asset ADD PRIMARY KEY (id);
      ALTER TABLE contract.contract ADD PRIMARY KEY (id);
      ALTER TABLE contract.contract_type ADD PRIMARY KEY (id);
      ALTER TABLE contract."grant" ADD PRIMARY KEY (id);
      ALTER TABLE contract.grant_capacity ADD PRIMARY KEY (id);
      ALTER TABLE contract.grant_type ADD PRIMARY KEY (id);
      ALTER TABLE contract.manifest ADD PRIMARY KEY (id);
      ALTER TABLE contract.manifest_asset ADD PRIMARY KEY (id);
      ALTER TABLE contract.scope ADD PRIMARY KEY (id);
      ALTER TABLE contract.state_type ADD PRIMARY KEY (id);
      ALTER TABLE contract.date_type ADD PRIMARY KEY (id);
      ALTER TABLE contract.scope_date ADD PRIMARY KEY (id);
      ALTER TABLE contract.scope_grant ADD PRIMARY KEY (id);
      ALTER TABLE contract.scope_manifest ADD PRIMARY KEY (id);
      ALTER TABLE contract.region ADD PRIMARY KEY (id);
      ALTER TABLE contract.scope_region ADD PRIMARY KEY (id);

      ALTER TABLE contract.contract ADD FOREIGN KEY (contract_type_id) REFERENCES contract.contract_type;
      ALTER TABLE contract."grant" ADD FOREIGN KEY (grant_capacity_id) REFERENCES contract.grant_capacity;
      ALTER TABLE contract."grant" ADD FOREIGN KEY (grant_type_id) REFERENCES contract.grant_type;
      ALTER TABLE contract.manifest_asset ADD FOREIGN KEY (manifest_id) REFERENCES contract.manifest;
      ALTER TABLE contract.manifest_asset ADD FOREIGN KEY (asset_id) REFERENCES asset.asset;
      ALTER TABLE contract.scope ADD FOREIGN KEY (contract_id) REFERENCES contract.contract;
      ALTER TABLE contract.scope ADD FOREIGN KEY (state_type_id) REFERENCES contract.state_type;
      ALTER TABLE contract.scope_date ADD FOREIGN KEY (date_type_id) REFERENCES contract.date_type;
      ALTER TABLE contract.scope_date ADD FOREIGN KEY (scope_id) REFERENCES contract.scope;
      ALTER TABLE contract.scope_grant ADD FOREIGN KEY (scope_id) REFERENCES contract.scope;
      ALTER TABLE contract.scope_grant ADD FOREIGN KEY (grant_id) REFERENCES contract."grant";
      ALTER TABLE contract.scope_manifest ADD FOREIGN KEY (scope_id) REFERENCES contract.scope;
      ALTER TABLE contract.scope_manifest ADD FOREIGN KEY (manifest_id) REFERENCES contract.manifest;
      ALTER TABLE contract.scope_region ADD FOREIGN KEY (region_id) REFERENCES contract.region;
      ALTER TABLE contract.scope_region ADD FOREIGN KEY (scope_id) REFERENCES contract.scope;
    `;

		const result = parsePostgresSQL(sql);

		expect(result.errors).toHaveLength(0);
		expect(result.foreignKeys).toHaveLength(15);

		// Verify a few specific FKs
		const contractTypeFK = result.foreignKeys.find(
			(fk) => fk.sourceTable === 'contract.contract' && fk.sourceColumn === 'contract_type_id'
		);
		expect(contractTypeFK).toEqual({
			sourceTable: 'contract.contract',
			sourceColumn: 'contract_type_id',
			targetTable: 'contract.contract_type',
			targetColumn: 'id'
		});

		// Cross-schema FK
		const assetFK = result.foreignKeys.find(
			(fk) => fk.sourceTable === 'contract.manifest_asset' && fk.sourceColumn === 'asset_id'
		);
		expect(assetFK).toEqual({
			sourceTable: 'contract.manifest_asset',
			sourceColumn: 'asset_id',
			targetTable: 'asset.asset',
			targetColumn: 'id'
		});

		// FK to quoted identifier table
		const grantFK = result.foreignKeys.find(
			(fk) => fk.sourceTable === 'contract.scope_grant' && fk.sourceColumn === 'grant_id'
		);
		expect(grantFK).toEqual({
			sourceTable: 'contract.scope_grant',
			sourceColumn: 'grant_id',
			targetTable: 'contract.grant',
			targetColumn: 'id'
		});
	});

	it('parses asset.asset table pattern', () => {
		const sql = `
      CREATE TABLE asset.asset (
        id bigint generated always as identity,
        name text not null,
        quantity integer default 100 not null,
        created_at timestamp with time zone default now() not null,
        system_metadata jsonb default '{}'::jsonb not null
      );
      ALTER TABLE asset.asset ADD PRIMARY KEY (id);
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables).toHaveLength(1);
		const table = result.tables[0];
		expect(table.qualifiedName).toBe('asset.asset');
		expect(table.columns).toHaveLength(5);

		expect(table.columns[0]).toMatchObject({ name: 'id', type: 'bigint', isPrimaryKey: true });
		expect(table.columns[1]).toMatchObject({ name: 'name', type: 'text' });
		expect(table.columns[2]).toMatchObject({ name: 'quantity', type: 'integer' });
		expect(table.columns[3]).toMatchObject({ name: 'created_at', type: 'timestamp with time zone' });
		expect(table.columns[4]).toMatchObject({ name: 'system_metadata', type: 'jsonb' });
	});

	it('parses contract.region with varchar array', () => {
		const sql = `
      CREATE TABLE contract.region (
        id integer generated always as identity,
        name text not null,
        country_codes_az_uq varchar(5)[] not null
      );
      ALTER TABLE contract.region ADD PRIMARY KEY (id);
    `;

		const result = parsePostgresSQL(sql);

		const table = result.tables[0];
		expect(table.columns[2]).toMatchObject({
			name: 'country_codes_az_uq',
			type: 'varchar(5)[]'
		});
	});

	it('parses contract.date_type with char(2)', () => {
		const sql = `
      CREATE TABLE contract.date_type (
        id integer generated always as identity,
        name text not null,
        kind char(2) not null
      );
    `;

		const result = parsePostgresSQL(sql);

		expect(result.tables[0].columns[2]).toMatchObject({
			name: 'kind',
			type: 'char(2)'
		});
	});
});

describe('generateForeignKeySql', () => {
	it('generates a named ALTER TABLE ADD CONSTRAINT FOREIGN KEY statement', () => {
		const sql = generateForeignKeySql('public.orders', 'user_id', 'public.users', 'id');
		expect(sql).toBe('ALTER TABLE public.orders ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id);');
	});

	it('strips quotes from identifiers when building the constraint name', () => {
		const sql = generateForeignKeySql('"public"."orders"', '"user_id"', '"public"."users"', 'id');
		expect(sql).toContain('CONSTRAINT orders_user_id_fkey');
	});
});

describe('removeForeignKeyStatement', () => {
	it('removes ALTER TABLE ADD FOREIGN KEY statement', () => {
		const sql = `
CREATE TABLE public.users (
  id BIGINT PRIMARY KEY
);

CREATE TABLE public.orders (
  id BIGINT PRIMARY KEY,
  user_id BIGINT
);

ALTER TABLE public.orders ADD FOREIGN KEY (user_id) REFERENCES public.users (id);
`;

		const fk = {
			sourceTable: 'public.orders',
			sourceColumn: 'user_id',
			targetTable: 'public.users',
			targetColumn: 'id'
		};

		const result = removeForeignKeyStatement(sql, fk);
		expect(result).toHaveProperty('sql');
		expect(result.sql).not.toContain('ALTER TABLE');
		expect(result.sql).toContain('CREATE TABLE public.users');
		expect(result.sql).toContain('CREATE TABLE public.orders');
	});

	it('removes ALTER TABLE ONLY ADD CONSTRAINT FOREIGN KEY (pg_dump form)', () => {
		const sql = `
CREATE TABLE system.auth_user (id integer PRIMARY KEY);
CREATE TABLE contract.manifest_asset (id integer PRIMARY KEY, updated_by integer);
ALTER TABLE ONLY "contract"."manifest_asset" ADD CONSTRAINT "manifest_asset_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "system"."auth_user" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
`;

		const fk = {
			sourceTable: 'contract.manifest_asset',
			sourceColumn: 'updated_by',
			targetTable: 'system.auth_user',
			targetColumn: 'id'
		};

		const result = removeForeignKeyStatement(sql, fk);
		expect(result).toHaveProperty('sql');
		expect(result.sql).not.toContain('FOREIGN KEY');
		expect(result.sql).not.toContain('manifest_asset_updated_by_fkey');
	});

	it('removes ALTER TABLE with CONSTRAINT name', () => {
		const sql = `
CREATE TABLE public.users (id BIGINT PRIMARY KEY);
CREATE TABLE public.orders (id BIGINT PRIMARY KEY, user_id BIGINT);
ALTER TABLE public.orders ADD CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES public.users (id);
`;

		const fk = {
			sourceTable: 'public.orders',
			sourceColumn: 'user_id',
			targetTable: 'public.users',
			targetColumn: 'id'
		};

		const result = removeForeignKeyStatement(sql, fk);
		expect(result).toHaveProperty('sql');
		expect(result.sql).not.toContain('FOREIGN KEY');
	});

	it('removes ALTER TABLE without target column specified', () => {
		const sql = `
CREATE TABLE public.users (id BIGINT PRIMARY KEY);
CREATE TABLE public.orders (id BIGINT PRIMARY KEY, user_id BIGINT);
ALTER TABLE public.orders ADD FOREIGN KEY (user_id) REFERENCES public.users;
`;

		const fk = {
			sourceTable: 'public.orders',
			sourceColumn: 'user_id',
			targetTable: 'public.users',
			targetColumn: 'id'
		};

		const result = removeForeignKeyStatement(sql, fk);
		expect(result).toHaveProperty('sql');
		expect(result.sql).not.toContain('FOREIGN KEY');
		expect(result.sql).not.toContain('REFERENCES');
	});

	it('removes inline REFERENCES from CREATE TABLE', () => {
		const sql = `
CREATE TABLE public.users (
  id BIGINT PRIMARY KEY
);

CREATE TABLE public.orders (
  id BIGINT PRIMARY KEY,
  user_id BIGINT REFERENCES public.users (id)
);
`;

		const fk = {
			sourceTable: 'public.orders',
			sourceColumn: 'user_id',
			targetTable: 'public.users',
			targetColumn: 'id'
		};

		const result = removeForeignKeyStatement(sql, fk);
		expect(result).toHaveProperty('sql');
		expect(result.sql).not.toContain('REFERENCES');
		expect(result.sql).toContain('user_id BIGINT');
	});

	it('removes inline REFERENCES with ON DELETE CASCADE', () => {
		const sql = `
CREATE TABLE public.users (id BIGINT PRIMARY KEY);
CREATE TABLE public.orders (
  id BIGINT PRIMARY KEY,
  user_id BIGINT REFERENCES public.users (id) ON DELETE CASCADE
);
`;

		const fk = {
			sourceTable: 'public.orders',
			sourceColumn: 'user_id',
			targetTable: 'public.users',
			targetColumn: 'id'
		};

		const result = removeForeignKeyStatement(sql, fk);
		expect(result).toHaveProperty('sql');
		expect(result.sql).not.toContain('REFERENCES');
		expect(result.sql).not.toContain('ON DELETE');
		expect(result.sql).toContain('user_id BIGINT');
	});

	it('returns error when FK not found', () => {
		const sql = `
CREATE TABLE public.users (id BIGINT PRIMARY KEY);
CREATE TABLE public.orders (id BIGINT PRIMARY KEY, user_id BIGINT);
`;

		const fk = {
			sourceTable: 'public.orders',
			sourceColumn: 'user_id',
			targetTable: 'public.users',
			targetColumn: 'id'
		};

		const result = removeForeignKeyStatement(sql, fk);
		expect(result).toHaveProperty('error');
	});

	it('only removes FK from the correct schema, not similar tables in other schemas', () => {
		const sql = `
CREATE TABLE asset.datum_type (id BIGINT PRIMARY KEY);
CREATE TABLE party.datum_type (id BIGINT PRIMARY KEY);
CREATE TABLE asset.datum (id BIGINT PRIMARY KEY, datum_type_id BIGINT);
CREATE TABLE party.datum (id BIGINT PRIMARY KEY, datum_type_id BIGINT);
ALTER TABLE asset.datum ADD FOREIGN KEY (datum_type_id) REFERENCES asset.datum_type;
ALTER TABLE party.datum ADD FOREIGN KEY (datum_type_id) REFERENCES party.datum_type;
`;

		const fk = {
			sourceTable: 'asset.datum',
			sourceColumn: 'datum_type_id',
			targetTable: 'asset.datum_type',
			targetColumn: 'id'
		};

		const result = removeForeignKeyStatement(sql, fk);
		expect(result).toHaveProperty('sql');
		// Should NOT contain the asset FK anymore
		expect(result.sql).not.toContain('ALTER TABLE asset.datum');
		// Should still contain the party FK
		expect(result.sql).toContain('ALTER TABLE party.datum ADD FOREIGN KEY (datum_type_id) REFERENCES party.datum_type');
	});
});

describe('addPrimaryKeyColumn', () => {
	it('adds new PRIMARY KEY when none exists', () => {
		const sql = `
CREATE TABLE public.users (
  id BIGINT,
  name TEXT
);
`;
		const result = addPrimaryKeyColumn(sql, 'public.users', 'id');
		expect(result).toHaveProperty('sql');
		expect(result.sql).toContain('ALTER TABLE public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id)');
	});

	it('extends existing ALTER TABLE PRIMARY KEY to compound key', () => {
		const sql = `
CREATE TABLE public.users (
  id BIGINT,
  tenant_id BIGINT,
  name TEXT
);

ALTER TABLE public.users ADD PRIMARY KEY (id);
`;
		const result = addPrimaryKeyColumn(sql, 'public.users', 'tenant_id');
		expect(result).toHaveProperty('sql');
		expect(result.sql).toContain('PRIMARY KEY (id, tenant_id)');
		expect(result.sql).not.toContain('PRIMARY KEY (id);');
	});

	it('extends existing table-level PRIMARY KEY constraint', () => {
		const sql = `
CREATE TABLE public.users (
  id BIGINT,
  tenant_id BIGINT,
  name TEXT,
  PRIMARY KEY (id)
);
`;
		const result = addPrimaryKeyColumn(sql, 'public.users', 'tenant_id');
		expect(result).toHaveProperty('sql');
		expect(result.sql).toContain('PRIMARY KEY (id, tenant_id)');
	});

	it('converts column-level PRIMARY KEY to compound key', () => {
		const sql = `
CREATE TABLE public.users (
  id BIGINT PRIMARY KEY,
  tenant_id BIGINT,
  name TEXT
);
`;
		const result = addPrimaryKeyColumn(sql, 'public.users', 'tenant_id');
		expect(result).toHaveProperty('sql');
		expect(result.sql).toContain('CONSTRAINT users_pkey PRIMARY KEY (id, tenant_id)');
		expect(result.sql).not.toContain('BIGINT PRIMARY KEY');
	});
});

describe('removePrimaryKeyColumn', () => {
	it('removes entire ALTER TABLE PRIMARY KEY when single column', () => {
		const sql = `
CREATE TABLE public.users (
  id BIGINT,
  name TEXT
);

ALTER TABLE public.users ADD PRIMARY KEY (id);
`;
		const result = removePrimaryKeyColumn(sql, 'public.users', 'id');
		expect(result).toHaveProperty('sql');
		expect(result.sql).not.toContain('PRIMARY KEY');
		expect(result.sql).not.toContain('ALTER TABLE');
	});

	it('removes column from compound ALTER TABLE PRIMARY KEY', () => {
		const sql = `
CREATE TABLE public.users (
  id BIGINT,
  tenant_id BIGINT,
  name TEXT
);

ALTER TABLE public.users ADD PRIMARY KEY (id, tenant_id);
`;
		const result = removePrimaryKeyColumn(sql, 'public.users', 'tenant_id');
		expect(result).toHaveProperty('sql');
		expect(result.sql).toContain('PRIMARY KEY (id)');
		expect(result.sql).not.toContain('PRIMARY KEY (id, tenant_id)');
	});

	it('removes entire table-level PRIMARY KEY constraint when single column', () => {
		const sql = `
CREATE TABLE public.users (
  id BIGINT,
  name TEXT,
  PRIMARY KEY (id)
);
`;
		const result = removePrimaryKeyColumn(sql, 'public.users', 'id');
		expect(result).toHaveProperty('sql');
		expect(result.sql).not.toContain('PRIMARY KEY');
	});

	it('removes column from compound table-level PRIMARY KEY', () => {
		const sql = `
CREATE TABLE public.users (
  id BIGINT,
  tenant_id BIGINT,
  name TEXT,
  PRIMARY KEY (id, tenant_id)
);
`;
		const result = removePrimaryKeyColumn(sql, 'public.users', 'tenant_id');
		expect(result).toHaveProperty('sql');
		expect(result.sql).toContain('PRIMARY KEY (id)');
		expect(result.sql).not.toContain(', tenant_id');
	});

	it('removes column-level PRIMARY KEY', () => {
		const sql = `
CREATE TABLE public.users (
  id BIGINT PRIMARY KEY,
  name TEXT
);
`;
		const result = removePrimaryKeyColumn(sql, 'public.users', 'id');
		expect(result).toHaveProperty('sql');
		expect(result.sql).not.toContain('PRIMARY KEY');
		expect(result.sql).toContain('id BIGINT');
	});

	it('returns error when column not found in PRIMARY KEY', () => {
		const sql = `
CREATE TABLE public.users (
  id BIGINT PRIMARY KEY,
  name TEXT
);
`;
		const result = removePrimaryKeyColumn(sql, 'public.users', 'name');
		expect(result).toHaveProperty('error');
	});
});

describe('findOrphanedAlterTables', () => {
	it('returns empty array when all ALTER TABLEs reference existing tables', () => {
		const sql = `
CREATE TABLE public.users (id BIGINT);
CREATE TABLE public.posts (id BIGINT, user_id BIGINT);
ALTER TABLE public.users ADD PRIMARY KEY (id);
ALTER TABLE public.posts ADD PRIMARY KEY (id);
ALTER TABLE public.posts ADD FOREIGN KEY (user_id) REFERENCES public.users (id);
`;
		const orphaned = findOrphanedAlterTables(sql);
		expect(orphaned).toHaveLength(0);
	});

	it('finds ALTER TABLE referencing non-existent table', () => {
		const sql = `
CREATE TABLE public.users (id BIGINT);
ALTER TABLE public.users ADD PRIMARY KEY (id);
ALTER TABLE public.posts ADD PRIMARY KEY (id);
`;
		const orphaned = findOrphanedAlterTables(sql);
		expect(orphaned).toHaveLength(1);
		expect(orphaned[0].tableName).toBe('public.posts');
		expect(orphaned[0].statement).toContain('ALTER TABLE public.posts');
	});

	it('finds multiple orphaned ALTER TABLEs', () => {
		const sql = `
CREATE TABLE public.users (id BIGINT);
ALTER TABLE public.users ADD PRIMARY KEY (id);
ALTER TABLE public.posts ADD PRIMARY KEY (id);
ALTER TABLE public.comments ADD PRIMARY KEY (id);
ALTER TABLE public.posts ADD FOREIGN KEY (user_id) REFERENCES public.users (id);
`;
		const orphaned = findOrphanedAlterTables(sql);
		expect(orphaned).toHaveLength(3);
		const tableNames = orphaned.map((o) => o.tableName);
		expect(tableNames).toContain('public.posts');
		expect(tableNames).toContain('public.comments');
	});

	it('handles schema-qualified table names', () => {
		const sql = `
CREATE TABLE contract.users (id BIGINT);
ALTER TABLE contract.users ADD PRIMARY KEY (id);
ALTER TABLE contract.posts ADD PRIMARY KEY (id);
`;
		const orphaned = findOrphanedAlterTables(sql);
		expect(orphaned).toHaveLength(1);
		expect(orphaned[0].tableName).toBe('contract.posts');
	});

	it('handles quoted identifiers', () => {
		const sql = `
CREATE TABLE contract."grant" (id BIGINT);
ALTER TABLE contract."grant" ADD PRIMARY KEY (id);
ALTER TABLE contract."order" ADD PRIMARY KEY (id);
`;
		const orphaned = findOrphanedAlterTables(sql);
		expect(orphaned).toHaveLength(1);
		expect(orphaned[0].tableName).toBe('contract.order');
	});

	it('includes position information for removal', () => {
		const sql = `CREATE TABLE public.users (id BIGINT);
ALTER TABLE public.deleted ADD PRIMARY KEY (id);`;
		const orphaned = findOrphanedAlterTables(sql);
		expect(orphaned).toHaveLength(1);
		expect(orphaned[0].start).toBeGreaterThan(0);
		expect(orphaned[0].end).toBeGreaterThan(orphaned[0].start);
		expect(sql.substring(orphaned[0].start, orphaned[0].end)).toBe('ALTER TABLE public.deleted ADD PRIMARY KEY (id);');
	});

	it('finds ALTER TABLE with REFERENCES to non-existent table', () => {
		const sql = `
CREATE TABLE party.company (id BIGINT, party_id BIGINT);
ALTER TABLE party.company ADD PRIMARY KEY (id);
ALTER TABLE party.company ADD FOREIGN KEY (party_id) REFERENCES party.party;
`;
		const orphaned = findOrphanedAlterTables(sql);
		expect(orphaned).toHaveLength(1);
		expect(orphaned[0].tableName).toBe('party.party');
		expect(orphaned[0].statement).toContain('REFERENCES party.party');
	});

	it('finds both target and REFERENCES orphans', () => {
		const sql = `
CREATE TABLE public.users (id BIGINT);
ALTER TABLE public.users ADD PRIMARY KEY (id);
ALTER TABLE public.posts ADD PRIMARY KEY (id);
ALTER TABLE public.users ADD FOREIGN KEY (org_id) REFERENCES public.orgs;
`;
		const orphaned = findOrphanedAlterTables(sql);
		expect(orphaned).toHaveLength(2);
		const tableNames = orphaned.map((o) => o.tableName);
		expect(tableNames).toContain('public.posts');
		expect(tableNames).toContain('public.orgs');
	});
});

describe('removeOrphanedAlterTables', () => {
	it('removes orphaned ALTER TABLE statements', () => {
		const sql = `
CREATE TABLE public.users (id BIGINT);

ALTER TABLE public.users ADD PRIMARY KEY (id);

ALTER TABLE public.posts ADD PRIMARY KEY (id);
`;
		const orphaned = findOrphanedAlterTables(sql);
		const result = removeOrphanedAlterTables(sql, orphaned);

		expect(result).toContain('CREATE TABLE public.users');
		expect(result).toContain('ALTER TABLE public.users ADD PRIMARY KEY');
		expect(result).not.toContain('ALTER TABLE public.posts');
	});

	it('removes multiple orphaned statements', () => {
		const sql = `
CREATE TABLE public.users (id BIGINT);
ALTER TABLE public.users ADD PRIMARY KEY (id);
ALTER TABLE public.posts ADD PRIMARY KEY (id);
ALTER TABLE public.comments ADD PRIMARY KEY (id);
ALTER TABLE public.posts ADD FOREIGN KEY (user_id) REFERENCES public.users (id);
`;
		const orphaned = findOrphanedAlterTables(sql);
		const result = removeOrphanedAlterTables(sql, orphaned);

		expect(result).toContain('CREATE TABLE public.users');
		expect(result).toContain('ALTER TABLE public.users ADD PRIMARY KEY');
		expect(result).not.toContain('ALTER TABLE public.posts');
		expect(result).not.toContain('ALTER TABLE public.comments');
	});

	it('returns original SQL when no orphaned statements', () => {
		const sql = `
CREATE TABLE public.users (id BIGINT);
ALTER TABLE public.users ADD PRIMARY KEY (id);
`;
		const orphaned = findOrphanedAlterTables(sql);
		const result = removeOrphanedAlterTables(sql, orphaned);

		expect(result.trim()).toBe(sql.trim());
	});

	it('cleans up excessive newlines after removal', () => {
		const sql = `
CREATE TABLE public.users (id BIGINT);


ALTER TABLE public.deleted ADD PRIMARY KEY (id);


ALTER TABLE public.users ADD PRIMARY KEY (id);
`;
		const orphaned = findOrphanedAlterTables(sql);
		const result = removeOrphanedAlterTables(sql, orphaned);

		// Should not have more than 2 consecutive newlines
		expect(result).not.toMatch(/\n{3,}/);
	});
});
