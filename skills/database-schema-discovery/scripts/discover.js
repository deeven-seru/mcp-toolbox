const { Client } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const yaml = require('yaml');
const fs = require('fs/promises');
const path = require('path');

async function getPostgresSchema(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();

  const tablesQuery = `
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `;
  const { rows: tableRows } = await client.query(tablesQuery);

  const schema = {};

  for (const { table_name } of tableRows) {
    const columnsQuery = `
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
    `;
    const { rows: columnRows } = await client.query(columnsQuery, [table_name]);
    
    // get primary keys
    const pkQuery = `
      SELECT a.attname as column_name
      FROM   pg_index i
      JOIN   pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE  i.indrelid = $1::regclass AND i.indisprimary
    `;
    let pks = [];
    try {
      const { rows: pkRows } = await client.query(pkQuery, [table_name]);
      pks = pkRows.map(r => r.column_name);
    } catch (e) {
      // ignore
    }

    schema[table_name] = {
      columns: columnRows.map(r => ({
        name: r.column_name,
        type: r.data_type,
        required: r.is_nullable === 'NO'
      })),
      primaryKeys: pks
    };
  }

  await client.end();
  return schema;
}

async function getSqliteSchema(filePath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err);
    });

    db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], (err, tables) => {
      if (err) return reject(err);

      const schema = {};
      let pending = tables.length;
      if (pending === 0) return resolve(schema);

      tables.forEach((table) => {
        const tableName = table.name;
        db.all(`PRAGMA table_info("${tableName}")`, [], (err, columns) => {
          if (err) return reject(err);

          schema[tableName] = {
            columns: columns.map(c => ({
              name: c.name,
              type: c.type,
              required: c.notnull === 1
            })),
            primaryKeys: columns.filter(c => c.pk > 0).map(c => c.name)
          };

          pending--;
          if (pending === 0) {
            db.close();
            resolve(schema);
          }
        });
      });
    });
  });
}

function mapPgTypeToMcpType(pgType) {
  pgType = (pgType || '').toLowerCase();
  if (['integer', 'bigint', 'smallint', 'int', 'serial', 'bigserial'].includes(pgType)) return 'integer';
  if (['numeric', 'double precision', 'real', 'decimal'].includes(pgType)) return 'float';
  if (['boolean', 'bool'].includes(pgType)) return 'boolean';
  return 'string';
}

function generateTools(schema, dbType, sourceName) {
  const tools = [];
  const typePrefix = dbType === 'postgres' ? 'postgres-sql' : 'sqlite-sql';

  for (const [tableName, tableSchema] of Object.entries(schema)) {
    // 1. List
    tools.push({
      kind: 'tool',
      name: `list_${tableName}`,
      type: typePrefix,
      source: sourceName,
      statement: `SELECT * FROM ${tableName} LIMIT 100`,
      description: `Get a list of records from ${tableName}`
    });

    // 2. Get (if pk exists)
    if (tableSchema.primaryKeys.length > 0) {
      const pk = tableSchema.primaryKeys[0];
      const pkCol = tableSchema.columns.find(c => c.name === pk);
      const paramPlaceholder = dbType === 'postgres' ? '$1' : '?';
      
      tools.push({
        kind: 'tool',
        name: `get_${tableName}`,
        type: typePrefix,
        source: sourceName,
        statement: `SELECT * FROM ${tableName} WHERE ${pk} = ${paramPlaceholder}`,
        description: `Get a single record from ${tableName} by ${pk}`,
        parameters: [{
          name: pk,
          type: mapPgTypeToMcpType(pkCol ? pkCol.type : 'integer'),
          description: `The ${pk} to lookup`
        }]
      });

      // 3. Delete
      tools.push({
        kind: 'tool',
        name: `delete_${tableName}`,
        type: typePrefix,
        source: sourceName,
        statement: `DELETE FROM ${tableName} WHERE ${pk} = ${paramPlaceholder}`,
        description: `Delete a record from ${tableName} by ${pk}`,
        parameters: [{
          name: pk,
          type: mapPgTypeToMcpType(pkCol ? pkCol.type : 'integer'),
          description: `The ${pk} to delete`
        }]
      });
    }

    // 4. Insert
    const insertCols = tableSchema.columns.filter(c => !tableSchema.primaryKeys.includes(c.name) || c.type.indexOf('serial') === -1); // approximate skipping auto increment
    const colNames = insertCols.map(c => c.name).join(', ');
    const placeholders = insertCols.map((_, i) => dbType === 'postgres' ? `$${i + 1}` : '?').join(', ');
    
    tools.push({
      kind: 'tool',
      name: `insert_${tableName}`,
      type: typePrefix,
      source: sourceName,
      statement: `INSERT INTO ${tableName} (${colNames}) VALUES (${placeholders})`,
      description: `Insert a new record into ${tableName}`,
      parameters: insertCols.map(c => ({
        name: c.name,
        type: mapPgTypeToMcpType(c.type),
        description: `The ${c.name} value`,
        required: c.required
      }))
    });

    // 5. Update (if pk exists and we have other cols)
    if (tableSchema.primaryKeys.length > 0 && insertCols.length > 0) {
      const pk = tableSchema.primaryKeys[0];
      const pkCol = tableSchema.columns.find(c => c.name === pk);
      const setClause = insertCols.map((c, i) => `${c.name} = ${dbType === 'postgres' ? `$${i + 1}` : '?'}`).join(', ');
      const pkPlaceholder = dbType === 'postgres' ? `$${insertCols.length + 1}` : '?';

      const updateParams = insertCols.map(c => ({
        name: c.name,
        type: mapPgTypeToMcpType(c.type),
        description: `The new ${c.name} value`,
        required: false // updates usually allow partial
      }));
      updateParams.push({
        name: pk,
        type: mapPgTypeToMcpType(pkCol ? pkCol.type : 'integer'),
        description: `The ${pk} of the record to update`,
        required: true
      });

      tools.push({
        kind: 'tool',
        name: `update_${tableName}`,
        type: typePrefix,
        source: sourceName,
        statement: `UPDATE ${tableName} SET ${setClause} WHERE ${pk} = ${pkPlaceholder}`,
        description: `Update a record in ${tableName} by ${pk}`,
        parameters: updateParams
      });
    }
  }

  return tools;
}

async function main() {
  const [,, dbType, connectionString, sourceName, outputFile] = process.argv;

  if (!dbType || !connectionString || !sourceName || !outputFile) {
    console.error('Usage: node discover.js <postgres|sqlite> <connectionString|file_path> <sourceName> <outputFile>');
    process.exit(1);
  }

  try {
    let schema;
    if (dbType === 'postgres') {
      schema = await getPostgresSchema(connectionString);
    } else if (dbType === 'sqlite') {
      schema = await getSqliteSchema(connectionString);
    } else {
      throw new Error(`Unsupported database type: ${dbType}`);
    }

    const tools = generateTools(schema, dbType, sourceName);
    
    // Format to YAML multiple documents using \n---\n
    const yamlString = tools.map(t => yaml.stringify(t)).join('\n---\n');

    await fs.writeFile(outputFile, yamlString, 'utf8');
    console.log(`Successfully generated ${tools.length} tools to ${outputFile}`);
  } catch (err) {
    console.error('Error generating tools:', err);
    process.exit(1);
  }
}

main();
