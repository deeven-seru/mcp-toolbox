---
name: database-schema-discovery
description: Automatically discovers tables and columns from a Postgres or SQLite database and generates a tools.yaml file containing basic CRUD operations (list, get, insert, update, delete) for each table.
---

# Database Schema Discovery Skill

This Agent Skill connects to a PostgreSQL or SQLite database, introspects its schema, and automatically generates a `tools.yaml` file containing `postgres-sql` or `sqlite-sql` MCP tools for each table.

## Usage

You can run this skill to generate a `tools.yaml` for a database source.

### PostgreSQL
```bash
node scripts/discover.js postgres "postgresql://user:password@localhost:5432/mydb" my_postgres tools.yaml
```

### SQLite
```bash
node scripts/discover.js sqlite my_database.db my_sqlite tools.yaml
```

## Arguments

1. **Database Type**: `postgres` or `sqlite`
2. **Connection String**: The connection URL for Postgres, or the file path for SQLite.
3. **Source Name**: The name of the MCP Toolbox source you want these tools to be associated with (e.g. `my_postgres`).
4. **Output File**: The path to write the generated `tools.yaml` to.

## Generated Tools

For each table in the database, the script will generate the following tools:
- `list_<table_name>`: Get a list of up to 100 records.
- `get_<table_name>`: Get a single record by primary key (if available).
- `insert_<table_name>`: Insert a new record.
- `update_<table_name>`: Update an existing record by primary key (if available).
- `delete_<table_name>`: Delete a record by primary key (if available).
