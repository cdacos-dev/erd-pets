/** @import { Table, Column, ForeignKey, ParseError, ParseResult, OrphanedAlterTable } from './types.js' */
import { tokenize, TokenStream } from './tokenizer.js';

/**
 * Keywords that signal the end of a column type definition
 */
const TYPE_END_KEYWORDS = new Set([
	'NOT',
	'NULL',
	'DEFAULT',
	'GENERATED',
	'CONSTRAINT',
	'PRIMARY',
	'REFERENCES',
	'UNIQUE',
	'CHECK'
]);

/**
 * Multi-word type continuations (when these keywords follow a type keyword, they're part of the type)
 */
const TYPE_CONTINUATION_KEYWORDS = new Set(['WITH', 'WITHOUT', 'TIME', 'ZONE', 'VARYING']);

/**
 * Parse Postgres SQL and extract table definitions
 * @param {string} sql
 * @returns {ParseResult}
 */
export function parsePostgresSQL(sql) {
	const tokens = tokenize(sql);
	const stream = new TokenStream(tokens);

	/** @type {Table[]} */
	const tables = [];
	/** @type {ForeignKey[]} */
	const foreignKeys = [];
	/** @type {ParseError[]} */
	const errors = [];
	/** @type {Map<string, Table>} */
	const tableMap = new Map();

	// Pass 1: Find CREATE TABLE statements
	while (!stream.isEOF()) {
		try {
			if (stream.is('KEYWORD', 'CREATE')) {
				const saved = stream.save();
				stream.next(); // consume CREATE

				if (stream.is('KEYWORD', 'TABLE')) {
					stream.next(); // consume TABLE

					// Handle IF NOT EXISTS (skip it)
					if (stream.is('KEYWORD', 'IF')) {
						stream.next();
						stream.match('KEYWORD', 'NOT');
						stream.match('KEYWORD', 'EXISTS');
					}

					const table = parseCreateTable(stream, foreignKeys, tableMap, errors);
					if (table) {
						tables.push(table);
						tableMap.set(table.qualifiedName, table);
					}
				} else {
					stream.restore(saved);
					stream.next();
				}
			} else if (stream.is('KEYWORD', 'ALTER')) {
				const saved = stream.save();
				stream.next(); // consume ALTER

				if (stream.is('KEYWORD', 'TABLE')) {
					stream.next(); // consume TABLE

					parseAlterTable(stream, tableMap, foreignKeys, errors);
				} else {
					stream.restore(saved);
					stream.next();
				}
			} else {
				stream.next();
			}
		} catch (e) {
			errors.push({
				message: e instanceof Error ? e.message : String(e),
				line: stream.line()
			});
			// Skip to next semicolon or statement keyword
			skipToNextStatement(stream);
		}
	}

	// Post-process: resolve any FKs with empty targetColumn (forward references from inline REFERENCES)
	for (const fk of foreignKeys) {
		if (!fk.targetColumn) {
			const targetTable = tableMap.get(fk.targetTable);
			if (targetTable) {
				const pkColumns = targetTable.columns.filter((c) => c.isPrimaryKey);
				if (pkColumns.length > 0) {
					fk.targetColumn = pkColumns[0].name;
				}
			}
		}
	}

	return { tables, foreignKeys, errors };
}

/**
 * Parse a CREATE TABLE statement (after CREATE TABLE keywords)
 * @param {TokenStream} stream
 * @param {ForeignKey[]} foreignKeys - Array to add inline foreign keys to
 * @param {Map<string, Table>} tableMap - Map of already-parsed tables for PK resolution
 * @param {ParseError[]} errors
 * @returns {Table | null}
 */
function parseCreateTable(stream, foreignKeys, tableMap, errors) {
	// Parse table name (schema.name or just name)
	const { schema, name } = parseQualifiedName(stream);

	if (!name) {
		errors.push({ message: 'Expected table name', line: stream.line() });
		return null;
	}

	const qualifiedName = `${schema}.${name}`;

	// Expect opening parenthesis
	if (!stream.match('PUNCTUATION', '(')) {
		errors.push({ message: 'Expected ( after table name', line: stream.line() });
		return null;
	}

	/** @type {Column[]} */
	const columns = [];

	// Parse columns
	while (!stream.isEOF() && !stream.is('PUNCTUATION', ')')) {
		try {
			// Check for table-level constraint (skip it)
			if (
				stream.is('KEYWORD', 'CONSTRAINT') ||
				stream.is('KEYWORD', 'PRIMARY') ||
				stream.is('KEYWORD', 'FOREIGN') ||
				stream.is('KEYWORD', 'UNIQUE') ||
				stream.is('KEYWORD', 'CHECK')
			) {
				skipTableConstraint(stream);
			} else {
				const column = parseColumn(stream, qualifiedName, foreignKeys, tableMap, errors);
				if (column) {
					columns.push(column);
				}
			}
		} catch (e) {
			errors.push({
				message: e instanceof Error ? e.message : String(e),
				line: stream.line()
			});
			// Skip to next comma or closing paren
			skipToColumnEnd(stream);
		}

		// Handle comma between columns
		stream.match('PUNCTUATION', ',');
	}

	// Consume closing parenthesis
	stream.match('PUNCTUATION', ')');

	// Skip to semicolon
	while (!stream.isEOF() && !stream.is('PUNCTUATION', ';')) {
		stream.next();
	}
	stream.match('PUNCTUATION', ';');

	return {
		schema,
		name,
		qualifiedName,
		columns
	};
}

/**
 * Parse a qualified name (schema.name or just name)
 * @param {TokenStream} stream
 * @returns {{ schema: string, name: string }}
 */
function parseQualifiedName(stream) {
	let schema = 'public';
	let name = '';

	// First part
	const first = parseIdentifier(stream);
	if (!first) {
		return { schema, name };
	}

	// Check for dot (schema.name)
	if (stream.match('PUNCTUATION', '.')) {
		schema = first;
		name = parseIdentifier(stream) || '';
	} else {
		name = first;
	}

	return { schema, name };
}

/**
 * Parse an identifier (quoted or unquoted)
 * @param {TokenStream} stream
 * @returns {string | null}
 */
function parseIdentifier(stream) {
	const token = stream.peek();
	if (token.type === 'IDENTIFIER' || token.type === 'QUOTED_IDENTIFIER') {
		stream.next();
		return token.value;
	}
	// Some keywords can be used as identifiers
	if (token.type === 'KEYWORD') {
		stream.next();
		return token.value.toLowerCase();
	}
	return null;
}

/**
 * Parse a column definition
 * @param {TokenStream} stream
 * @param {string} qualifiedTableName - The qualified name of the table containing this column
 * @param {ForeignKey[]} foreignKeys - Array to add inline foreign keys to
 * @param {Map<string, Table>} tableMap - Map of already-parsed tables for PK resolution
 * @param {ParseError[]} errors - Array to add errors to
 * @returns {Column | null}
 */
function parseColumn(stream, qualifiedTableName, foreignKeys, tableMap, errors) {
	const name = parseIdentifier(stream);
	if (!name) {
		return null;
	}

	const type = parseColumnType(stream);

	// Parse column modifiers, including inline REFERENCES
	parseColumnModifiers(stream, qualifiedTableName, name, foreignKeys, tableMap, errors);

	return {
		name,
		type,
		isPrimaryKey: false
	};
}

/**
 * Parse column type, handling multi-word types and arrays
 * @param {TokenStream} stream
 * @returns {string}
 */
function parseColumnType(stream) {
	const parts = [];

	// Get first part of type
	const firstPart = parseTypePart(stream);
	if (!firstPart) {
		return 'unknown';
	}
	parts.push(firstPart);

	// Handle parenthesized arguments like varchar(255) or decimal(10,2)
	if (stream.is('PUNCTUATION', '(')) {
		parts.push(parseParenthesizedArgs(stream));
	}

	// Handle array brackets
	if (stream.is('PUNCTUATION', '[')) {
		stream.next(); // [
		stream.match('PUNCTUATION', ']');
		parts.push('[]');
	}

	// Handle multi-word types (timestamp with time zone, character varying, etc.)
	while (!stream.isEOF()) {
		const token = stream.peek();

		// Check if this is a type continuation keyword
		if (token.type === 'KEYWORD' && TYPE_CONTINUATION_KEYWORDS.has(token.value)) {
			stream.next();
			parts.push(token.value.toLowerCase());
		} else {
			break;
		}
	}

	return parts.join(' ').replace(/ \[\]$/, '[]').replace(/ \(/g, '(').replace(/\) /g, ')');
}

/**
 * Parse a single type part (keyword or identifier)
 * @param {TokenStream} stream
 * @returns {string | null}
 */
function parseTypePart(stream) {
	const token = stream.peek();
	if (token.type === 'KEYWORD' && !TYPE_END_KEYWORDS.has(token.value)) {
		stream.next();
		return token.value.toLowerCase();
	}
	if (token.type === 'IDENTIFIER') {
		stream.next();
		return token.value;
	}
	return null;
}

/**
 * Parse parenthesized arguments like (255) or (10,2)
 * @param {TokenStream} stream
 * @returns {string}
 */
function parseParenthesizedArgs(stream) {
	let result = '';
	let depth = 0;

	while (!stream.isEOF()) {
		const token = stream.next();

		if (token.type === 'PUNCTUATION' && token.value === '(') {
			depth++;
			result += '(';
		} else if (token.type === 'PUNCTUATION' && token.value === ')') {
			depth--;
			result += ')';
			if (depth === 0) {
				break;
			}
		} else if (token.type === 'PUNCTUATION' && token.value === ',') {
			result += ',';
		} else if (token.type === 'NUMBER') {
			result += token.value;
		} else if (token.type === 'IDENTIFIER' || token.type === 'KEYWORD') {
			result += token.value.toLowerCase();
		}
	}

	return result;
}

/**
 * Parse column modifiers, extracting inline REFERENCES if present
 * @param {TokenStream} stream
 * @param {string} qualifiedTableName - The qualified name of the table containing this column
 * @param {string} columnName - The name of this column
 * @param {ForeignKey[]} foreignKeys - Array to add inline foreign keys to
 * @param {Map<string, Table>} tableMap - Map of already-parsed tables for PK resolution
 * @param {ParseError[]} errors - Array to add errors to
 */
function parseColumnModifiers(stream, qualifiedTableName, columnName, foreignKeys, tableMap, errors) {
	let parenDepth = 0;

	while (!stream.isEOF()) {
		const token = stream.peek();

		if (token.type === 'PUNCTUATION') {
			if (token.value === '(') {
				parenDepth++;
				stream.next();
			} else if (token.value === ')') {
				if (parenDepth > 0) {
					parenDepth--;
					stream.next();
				} else {
					// End of column list
					break;
				}
			} else if (token.value === ',' && parenDepth === 0) {
				// End of this column
				break;
			} else {
				stream.next();
			}
		} else if (token.type === 'KEYWORD' && token.value === 'REFERENCES' && parenDepth === 0) {
			// Parse inline foreign key reference
			const fkLine = stream.line();
			stream.next(); // consume REFERENCES

			const { schema: targetSchema, name: targetName } = parseQualifiedName(stream);
			const targetQualifiedName = `${targetSchema}.${targetName}`;

			// Check for optional target column
			let targetColumn = '';
			if (stream.match('PUNCTUATION', '(')) {
				const col = parseIdentifier(stream);
				if (col) {
					targetColumn = col;
				}
				stream.match('PUNCTUATION', ')');
			}

			// If no target column specified, try to resolve from PK
			if (!targetColumn) {
				const targetTable = tableMap.get(targetQualifiedName);
				if (targetTable) {
					const pkColumns = targetTable.columns.filter((c) => c.isPrimaryKey);
					if (pkColumns.length > 0) {
						targetColumn = pkColumns[0].name;
					} else {
						errors.push({
							message: `Inline foreign key references ${targetQualifiedName} which has no primary key`,
							line: fkLine
						});
					}
				}
				// If target table not found yet, leave targetColumn empty for later resolution
			}

			foreignKeys.push({
				sourceTable: qualifiedTableName,
				sourceColumn: columnName,
				targetTable: targetQualifiedName,
				targetColumn
			});
		} else {
			stream.next();
		}
	}
}

/**
 * Skip column modifiers until we hit comma or closing paren (legacy, kept for table constraints)
 * @param {TokenStream} stream
 */
function skipColumnModifiers(stream) {
	let parenDepth = 0;

	while (!stream.isEOF()) {
		const token = stream.peek();

		if (token.type === 'PUNCTUATION') {
			if (token.value === '(') {
				parenDepth++;
				stream.next();
			} else if (token.value === ')') {
				if (parenDepth > 0) {
					parenDepth--;
					stream.next();
				} else {
					// End of column list
					break;
				}
			} else if (token.value === ',' && parenDepth === 0) {
				// End of this column
				break;
			} else {
				stream.next();
			}
		} else {
			stream.next();
		}
	}
}

/**
 * Skip a table-level constraint
 * @param {TokenStream} stream
 */
function skipTableConstraint(stream) {
	let parenDepth = 0;

	while (!stream.isEOF()) {
		const token = stream.peek();

		if (token.type === 'PUNCTUATION') {
			if (token.value === '(') {
				parenDepth++;
				stream.next();
			} else if (token.value === ')') {
				if (parenDepth > 0) {
					parenDepth--;
					stream.next();
				} else {
					break;
				}
			} else if (token.value === ',' && parenDepth === 0) {
				break;
			} else {
				stream.next();
			}
		} else {
			stream.next();
		}
	}
}

/**
 * Skip to next comma or closing paren (error recovery)
 * @param {TokenStream} stream
 */
function skipToColumnEnd(stream) {
	let parenDepth = 0;

	while (!stream.isEOF()) {
		const token = stream.peek();

		if (token.type === 'PUNCTUATION') {
			if (token.value === '(') {
				parenDepth++;
			} else if (token.value === ')') {
				if (parenDepth > 0) {
					parenDepth--;
				} else {
					break;
				}
			} else if (token.value === ',' && parenDepth === 0) {
				break;
			}
		}
		stream.next();
	}
}

/**
 * Skip to next statement (error recovery)
 * @param {TokenStream} stream
 */
function skipToNextStatement(stream) {
	while (!stream.isEOF()) {
		if (stream.is('PUNCTUATION', ';')) {
			stream.next();
			break;
		}
		stream.next();
	}
}

/**
 * Parse ALTER TABLE statement for primary keys and foreign keys
 * @param {TokenStream} stream
 * @param {Map<string, Table>} tableMap
 * @param {ForeignKey[]} foreignKeys
 * @param {ParseError[]} errors
 */
function parseAlterTable(stream, tableMap, foreignKeys, errors) {
	// Skip optional IF EXISTS and ONLY (e.g. ALTER TABLE IF EXISTS ONLY name)
	stream.match('KEYWORD', 'IF');
	stream.match('KEYWORD', 'EXISTS');
	stream.match('KEYWORD', 'ONLY');

	const { schema, name } = parseQualifiedName(stream);
	const qualifiedName = `${schema}.${name}`;

	// Skip optional trailing * (legacy "operate on inheritance descendants" syntax)
	stream.match('OPERATOR', '*');

	// Look for ADD PRIMARY KEY or ADD FOREIGN KEY
	while (!stream.isEOF() && !stream.is('PUNCTUATION', ';')) {
		if (stream.is('KEYWORD', 'ADD')) {
			stream.next();

			// Could be ADD CONSTRAINT name PRIMARY/FOREIGN KEY or ADD PRIMARY/FOREIGN KEY
			if (stream.is('KEYWORD', 'CONSTRAINT')) {
				stream.next();
				parseIdentifier(stream); // constraint name
			}

			if (stream.is('KEYWORD', 'PRIMARY')) {
				stream.next();
				if (stream.match('KEYWORD', 'KEY')) {
					// Parse the column list
					if (stream.match('PUNCTUATION', '(')) {
						const pkColumns = [];
						while (!stream.isEOF() && !stream.is('PUNCTUATION', ')')) {
							const col = parseIdentifier(stream);
							if (col) {
								pkColumns.push(col);
							}
							stream.match('PUNCTUATION', ',');
						}
						stream.match('PUNCTUATION', ')');

						// Mark columns as primary key
						const table = tableMap.get(qualifiedName);
						if (table) {
							for (const pkCol of pkColumns) {
								const column = table.columns.find((c) => c.name === pkCol);
								if (column) {
									column.isPrimaryKey = true;
								}
							}
						}
					}
				}
			} else if (stream.is('KEYWORD', 'FOREIGN')) {
				const fkLine = stream.line();
				stream.next();
				if (stream.match('KEYWORD', 'KEY')) {
					// Parse source column(s)
					if (stream.match('PUNCTUATION', '(')) {
						const sourceColumns = [];
						while (!stream.isEOF() && !stream.is('PUNCTUATION', ')')) {
							const col = parseIdentifier(stream);
							if (col) {
								sourceColumns.push(col);
							}
							stream.match('PUNCTUATION', ',');
						}
						stream.match('PUNCTUATION', ')');

						// Expect REFERENCES
						if (stream.match('KEYWORD', 'REFERENCES')) {
							const { schema: targetSchema, name: targetName } = parseQualifiedName(stream);
							const targetQualifiedName = `${targetSchema}.${targetName}`;

							// Check for optional target column(s)
							let targetColumns = [];
							if (stream.match('PUNCTUATION', '(')) {
								while (!stream.isEOF() && !stream.is('PUNCTUATION', ')')) {
									const col = parseIdentifier(stream);
									if (col) {
										targetColumns.push(col);
									}
									stream.match('PUNCTUATION', ',');
								}
								stream.match('PUNCTUATION', ')');
							}

							// If no target columns specified, resolve to PK
							if (targetColumns.length === 0) {
								const targetTable = tableMap.get(targetQualifiedName);
								if (targetTable) {
									const pkColumns = targetTable.columns.filter((c) => c.isPrimaryKey);
									if (pkColumns.length > 0) {
										targetColumns = pkColumns.map((c) => c.name);
									} else {
										errors.push({
											message: `Foreign key references ${targetQualifiedName} which has no primary key`,
											line: fkLine
										});
									}
								}
								// If target table not found, we still create the FK (table might be defined later or external)
								// but we can't resolve the column
							}

							// Create FK entries (one per source column if multiple)
							for (let i = 0; i < sourceColumns.length; i++) {
								const targetCol = targetColumns[i] || targetColumns[0] || '';
								if (targetCol || targetColumns.length === 0) {
									foreignKeys.push({
										sourceTable: qualifiedName,
										sourceColumn: sourceColumns[i],
										targetTable: targetQualifiedName,
										targetColumn: targetCol
									});
								}
							}
						}
					}
				}
			}
		} else {
			stream.next();
		}
	}

	stream.match('PUNCTUATION', ';');
}

/**
 * Template for a new CREATE TABLE statement
 */
export const CREATE_TABLE_TEMPLATE = `CREATE TABLE schema.table_name (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT
);`;

/**
 * Strip surrounding double quotes from an identifier.
 * @param {string} identifier
 * @returns {string}
 */
function stripQuotes(identifier) {
	return identifier.replace(/^"(.*)"$/, '$1');
}

/**
 * Get the unqualified, unquoted table name from a possibly schema-qualified name.
 * @param {string} qualifiedName - e.g. "schema.table" or just "table"
 * @returns {string}
 */
function unqualifiedTableName(qualifiedName) {
	const parts = qualifiedName.split('.');
	return stripQuotes(parts[parts.length - 1]);
}

/**
 * Build the conventional PostgreSQL primary key constraint name: <table>_pkey
 * @param {string} qualifiedTable
 * @returns {string}
 */
function primaryKeyConstraintName(qualifiedTable) {
	return `${unqualifiedTableName(qualifiedTable)}_pkey`;
}

/**
 * Build the conventional PostgreSQL foreign key constraint name: <table>_<column>_fkey
 * @param {string} qualifiedTable
 * @param {string} columnName
 * @returns {string}
 */
function foreignKeyConstraintName(qualifiedTable, columnName) {
	return `${unqualifiedTableName(qualifiedTable)}_${stripQuotes(columnName)}_fkey`;
}

/**
 * Generate an ALTER TABLE ADD FOREIGN KEY statement
 * @param {string} sourceTable - Fully qualified source table name
 * @param {string} sourceColumn - Column in the source table
 * @param {string} targetTable - Fully qualified target table name
 * @param {string} targetColumn - Column in the target table
 * @returns {string}
 */
export function generateForeignKeySql(sourceTable, sourceColumn, targetTable, targetColumn) {
	const constraintName = foreignKeyConstraintName(sourceTable, sourceColumn);
	return `ALTER TABLE ${sourceTable} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${sourceColumn}) REFERENCES ${targetTable} (${targetColumn});`;
}

/**
 * Find and remove a foreign key statement from SQL content.
 * Supports both ALTER TABLE ADD FOREIGN KEY and inline REFERENCES in CREATE TABLE.
 * Returns the modified SQL content, or an error if the FK could not be found.
 *
 * @param {string} sqlContent - The full SQL content
 * @param {ForeignKey} fk - The foreign key to remove
 * @returns {{ sql: string } | { error: string }}
 */
export function removeForeignKeyStatement(sqlContent, fk) {
	const [sourceSchema, sourceTableName] = fk.sourceTable.split('.');
	const [targetSchema, targetTableName] = fk.targetTable.split('.');

	// Build patterns that match either "schema.table" or just "table" (for default schema)
	// Also handle quoted identifiers like "schema"."table"
	const sourceTablePattern = buildTableNamePattern(sourceSchema, sourceTableName);
	const targetTablePattern = buildTableNamePattern(targetSchema, targetTableName);

	// First, try to find ALTER TABLE ... ADD FOREIGN KEY statement
	// Note: target column (id) is optional in SQL - if omitted, it references the PK
	const alterTablePattern = new RegExp(
		`ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${sourceTablePattern}\\s+ADD\\s+(?:CONSTRAINT\\s+[\\w"]+\\s+)?FOREIGN\\s+KEY\\s*\\(\\s*"?${escapeRegex(fk.sourceColumn)}"?\\s*\\)\\s*REFERENCES\\s+${targetTablePattern}(?:\\s*\\(\\s*"?(?:${escapeRegex(fk.targetColumn)})?"?\\s*\\))?[^;]*;`,
		'gi'
	);

	const alterMatches = [...sqlContent.matchAll(alterTablePattern)];

	if (alterMatches.length > 0) {
		// Remove ALTER TABLE statements from end to start
		const rangesToRemove = alterMatches
			.map((m) => ({ start: m.index, end: m.index + m[0].length }))
			.sort((a, b) => b.start - a.start);

		let newSqlContent = sqlContent;
		for (const range of rangesToRemove) {
			newSqlContent = removeRangeWithWhitespace(newSqlContent, range.start, range.end);
		}

		return { sql: newSqlContent.replace(/\n{3,}/g, '\n\n').trim() + '\n' };
	}

	// Try to find inline REFERENCES in CREATE TABLE
	// First, find the CREATE TABLE for the source table
	const createTablePattern = new RegExp(
		`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${sourceTablePattern}\\s*\\([^;]+\\)\\s*;`,
		'gis'
	);

	const createMatch = createTablePattern.exec(sqlContent);
	if (!createMatch) {
		return { error: `Could not find CREATE TABLE for ${fk.sourceTable} in the SQL.` };
	}

	const createTableStart = createMatch.index;
	const createTableSql = createMatch[0];

	// Find the column definition line that contains our source column and the REFERENCES
	// Pattern: column_name TYPE ... REFERENCES target
	const columnWithRefPattern = new RegExp(
		`("?${escapeRegex(fk.sourceColumn)}"?\\s+[^,)]+?)((?:CONSTRAINT\\s+[\\w"]+\\s+)?REFERENCES\\s+${targetTablePattern}(?:\\s*\\(\\s*"?(?:${escapeRegex(fk.targetColumn)})?"?\\s*\\))?(?:\\s+(?:ON\\s+(?:DELETE|UPDATE)\\s+(?:CASCADE|RESTRICT|NO\\s+ACTION|SET\\s+NULL|SET\\s+DEFAULT)))*)`,
		'gi'
	);

	const columnMatch = columnWithRefPattern.exec(createTableSql);
	if (!columnMatch) {
		// Try table-level FOREIGN KEY constraint: FOREIGN KEY (column) REFERENCES table (column)
		// May be preceded by CONSTRAINT name
		const tableConstraintPattern = new RegExp(
			`,?\\s*(?:CONSTRAINT\\s+[\\w"]+\\s+)?FOREIGN\\s+KEY\\s*\\(\\s*"?${escapeRegex(fk.sourceColumn)}"?\\s*\\)\\s*REFERENCES\\s+${targetTablePattern}(?:\\s*\\(\\s*"?(?:${escapeRegex(fk.targetColumn)})?"?\\s*\\))?(?:\\s+(?:ON\\s+(?:DELETE|UPDATE)\\s+(?:CASCADE|RESTRICT|NO\\s+ACTION|SET\\s+NULL|SET\\s+DEFAULT)))*`,
			'gi'
		);

		const constraintMatch = tableConstraintPattern.exec(createTableSql);
		if (!constraintMatch) {
			return { error: `Could not find FOREIGN KEY definition for column ${fk.sourceColumn} in the SQL.` };
		}

		// Remove the table-level constraint
		const matchStartInCreate = constraintMatch.index;
		const absoluteStart = createTableStart + matchStartInCreate;
		const matchLength = constraintMatch[0].length;

		const newSqlContent = sqlContent.slice(0, absoluteStart) + sqlContent.slice(absoluteStart + matchLength);
		return { sql: newSqlContent.replace(/\n{3,}/g, '\n\n').trim() + '\n' };
	}

	// Remove just the REFERENCES clause from the column definition
	const beforeRef = columnMatch[1];
	const refClause = columnMatch[2];
	const fullMatch = columnMatch[0];

	// Calculate positions in the original SQL
	const matchStartInCreate = columnMatch.index;
	const absoluteStart = createTableStart + matchStartInCreate;

	// Replace the full match with just the part before REFERENCES (trimmed)
	const replacement = beforeRef.trimEnd();
	const newSqlContent = sqlContent.slice(0, absoluteStart) + replacement + sqlContent.slice(absoluteStart + fullMatch.length);

	return { sql: newSqlContent.replace(/\n{3,}/g, '\n\n').trim() + '\n' };
}

/**
 * Add a column to the primary key of a table.
 * If a PK already exists, creates a compound key. Otherwise creates a new PK.
 *
 * @param {string} sqlContent - The full SQL content
 * @param {string} tableName - Qualified table name (schema.table)
 * @param {string} columnName - Column to add to PK
 * @returns {{ sql: string } | { error: string }}
 */
export function addPrimaryKeyColumn(sqlContent, tableName, columnName) {
	const [schema, table] = tableName.split('.');
	const tablePattern = buildTableNamePattern(schema, table);

	// First, try to find existing ALTER TABLE ... ADD PRIMARY KEY
	const alterPkPattern = new RegExp(
		`(ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${tablePattern}\\s+ADD\\s+(?:CONSTRAINT\\s+[\\w"]+\\s+)?PRIMARY\\s+KEY\\s*\\()([^)]+)(\\)[^;]*;)`,
		'gi'
	);

	const alterMatch = alterPkPattern.exec(sqlContent);
	if (alterMatch) {
		// Extend existing ALTER TABLE PK with new column
		const before = alterMatch[1];
		const existingColumns = alterMatch[2];
		const after = alterMatch[3];
		const newColumns = `${existingColumns.trim()}, ${columnName}`;
		const newStatement = before + newColumns + after;

		const newSqlContent = sqlContent.slice(0, alterMatch.index) + newStatement + sqlContent.slice(alterMatch.index + alterMatch[0].length);
		return { sql: newSqlContent.trim() + '\n' };
	}

	// Try to find inline PRIMARY KEY in CREATE TABLE (either column-level or table-level constraint)
	const createTablePattern = new RegExp(
		`(CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${tablePattern}\\s*\\()([^;]+)(\\)\\s*;)`,
		'gis'
	);

	const createMatch = createTablePattern.exec(sqlContent);
	if (createMatch) {
		const createStart = createMatch[1];
		const createBody = createMatch[2];
		const createEnd = createMatch[3];

		// Check for table-level PRIMARY KEY constraint: PRIMARY KEY (col1, col2)
		const tablePkPattern = /(,?\s*(?:CONSTRAINT\s+[\w"]+\s+)?PRIMARY\s+KEY\s*\()([^)]+)(\))/gi;
		const tablePkMatch = tablePkPattern.exec(createBody);

		if (tablePkMatch) {
			// Extend table-level PK constraint
			const pkBefore = tablePkMatch[1];
			const existingColumns = tablePkMatch[2];
			const pkAfter = tablePkMatch[3];
			const newColumns = `${existingColumns.trim()}, ${columnName}`;
			const newBody = createBody.slice(0, tablePkMatch.index) + pkBefore + newColumns + pkAfter + createBody.slice(tablePkMatch.index + tablePkMatch[0].length);
			const newSqlContent = sqlContent.slice(0, createMatch.index) + createStart + newBody + createEnd + sqlContent.slice(createMatch.index + createMatch[0].length);
			return { sql: newSqlContent.trim() + '\n' };
		}

		// Check for column-level PRIMARY KEY on a different column
		const columnPkPattern = /("?\w+"?\s+[^,)]+?)\s+PRIMARY\s+KEY/gi;
		const columnPkMatch = columnPkPattern.exec(createBody);

		if (columnPkMatch) {
			// Convert column-level PK to table-level compound PK
			// First, find the column name from the match
			const colDefMatch = /^"?(\w+)"?/.exec(columnPkMatch[1].trim());
			if (colDefMatch) {
				const existingPkColumn = colDefMatch[1];
				// Remove PRIMARY KEY from column definition
				const newBody = createBody.replace(/(\s+)PRIMARY\s+KEY/i, '');
				// Add table-level compound PK at the end
				const trimmedBody = newBody.trimEnd();
				const hasTrailingComma = trimmedBody.endsWith(',');
				const bodyWithConstraint = trimmedBody + (hasTrailingComma ? '' : ',') + `\n  CONSTRAINT ${primaryKeyConstraintName(tableName)} PRIMARY KEY (${existingPkColumn}, ${columnName})`;
				const newSqlContent = sqlContent.slice(0, createMatch.index) + createStart + bodyWithConstraint + createEnd + sqlContent.slice(createMatch.index + createMatch[0].length);
				return { sql: newSqlContent.trim() + '\n' };
			}
		}
	}

	// No existing PK found - append ALTER TABLE ADD PRIMARY KEY
	const alterStatement = `\nALTER TABLE ${tableName} ADD CONSTRAINT ${primaryKeyConstraintName(tableName)} PRIMARY KEY (${columnName});\n`;
	return { sql: sqlContent.trim() + alterStatement };
}

/**
 * Remove a column from the primary key of a table.
 * If it's the last column, removes the entire PK constraint.
 *
 * @param {string} sqlContent - The full SQL content
 * @param {string} tableName - Qualified table name (schema.table)
 * @param {string} columnName - Column to remove from PK
 * @returns {{ sql: string } | { error: string }}
 */
export function removePrimaryKeyColumn(sqlContent, tableName, columnName) {
	const [schema, table] = tableName.split('.');
	const tablePattern = buildTableNamePattern(schema, table);

	// First, try to find ALTER TABLE ... ADD PRIMARY KEY
	const alterPkPattern = new RegExp(
		`(ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${tablePattern}\\s+ADD\\s+(?:CONSTRAINT\\s+[\\w"]+\\s+)?PRIMARY\\s+KEY\\s*\\()([^)]+)(\\)[^;]*;)`,
		'gi'
	);

	const alterMatch = alterPkPattern.exec(sqlContent);
	if (alterMatch) {
		const existingColumns = alterMatch[2]
			.split(',')
			.map((c) => c.trim().replace(/^"|"$/g, ''));

		if (existingColumns.length === 1) {
			// Remove entire ALTER TABLE statement
			return { sql: removeRangeWithWhitespace(sqlContent, alterMatch.index, alterMatch.index + alterMatch[0].length).replace(/\n{3,}/g, '\n\n').trim() + '\n' };
		}

		// Remove just the column from the list
		const newColumns = existingColumns.filter((c) => c.toLowerCase() !== columnName.toLowerCase()).join(', ');
		const newStatement = alterMatch[1] + newColumns + alterMatch[3];
		const newSqlContent = sqlContent.slice(0, alterMatch.index) + newStatement + sqlContent.slice(alterMatch.index + alterMatch[0].length);
		return { sql: newSqlContent.trim() + '\n' };
	}

	// Try to find inline PRIMARY KEY in CREATE TABLE
	const createTablePattern = new RegExp(
		`(CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${tablePattern}\\s*\\()([^;]+)(\\)\\s*;)`,
		'gis'
	);

	const createMatch = createTablePattern.exec(sqlContent);
	if (!createMatch) {
		return { error: `Could not find table ${tableName} in the SQL.` };
	}

	const createStart = createMatch[1];
	const createBody = createMatch[2];
	const createEnd = createMatch[3];

	// Check for table-level PRIMARY KEY constraint: PRIMARY KEY (col1, col2)
	const tablePkPattern = /(,?\s*(?:CONSTRAINT\s+[\w"]+\s+)?PRIMARY\s+KEY\s*\()([^)]+)(\))/gi;
	const tablePkMatch = tablePkPattern.exec(createBody);

	if (tablePkMatch) {
		const existingColumns = tablePkMatch[2]
			.split(',')
			.map((c) => c.trim().replace(/^"|"$/g, ''));

		if (existingColumns.length === 1) {
			// Remove entire constraint
			const newBody = createBody.slice(0, tablePkMatch.index) + createBody.slice(tablePkMatch.index + tablePkMatch[0].length);
			// Clean up any trailing comma before the removed constraint
			const cleanedBody = newBody.replace(/,(\s*)$/, '$1');
			const newSqlContent = sqlContent.slice(0, createMatch.index) + createStart + cleanedBody + createEnd + sqlContent.slice(createMatch.index + createMatch[0].length);
			return { sql: newSqlContent.replace(/\n{3,}/g, '\n\n').trim() + '\n' };
		}

		// Remove just the column from the list
		const newColumns = existingColumns.filter((c) => c.toLowerCase() !== columnName.toLowerCase()).join(', ');
		const newBody = createBody.slice(0, tablePkMatch.index) + tablePkMatch[1] + newColumns + tablePkMatch[3] + createBody.slice(tablePkMatch.index + tablePkMatch[0].length);
		const newSqlContent = sqlContent.slice(0, createMatch.index) + createStart + newBody + createEnd + sqlContent.slice(createMatch.index + createMatch[0].length);
		return { sql: newSqlContent.trim() + '\n' };
	}

	// Check for column-level PRIMARY KEY
	const columnPkPattern = new RegExp(
		`("?${escapeRegex(columnName)}"?\\s+[^,)]+?)\\s+PRIMARY\\s+KEY`,
		'gi'
	);
	const columnPkMatch = columnPkPattern.exec(createBody);

	if (columnPkMatch) {
		// Remove PRIMARY KEY from the column definition
		const newBody = createBody.slice(0, columnPkMatch.index) + columnPkMatch[1] + createBody.slice(columnPkMatch.index + columnPkMatch[0].length);
		const newSqlContent = sqlContent.slice(0, createMatch.index) + createStart + newBody + createEnd + sqlContent.slice(createMatch.index + createMatch[0].length);
		return { sql: newSqlContent.trim() + '\n' };
	}

	return { error: `Could not find PRIMARY KEY definition for column ${columnName} in ${tableName}.` };
}

/**
 * Remove a range from content, cleaning up surrounding whitespace.
 * @param {string} content
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
function removeRangeWithWhitespace(content, start, end) {
	// Expand to include trailing newlines
	while (end < content.length && (content[end] === '\n' || content[end] === '\r')) {
		end++;
	}

	// Expand to include leading newlines (but keep one)
	while (start > 0 && (content[start - 1] === '\n' || content[start - 1] === '\r')) {
		start--;
	}
	if (start > 0 && content[start] === '\n') {
		start++;
	}

	return content.slice(0, start) + content.slice(end);
}

/**
 * Escape special regex characters in a string.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a regex pattern that matches a qualified table name.
 * Matches: schema.table, "schema"."table", "schema".table, schema."table", or just table
 * @param {string} schema
 * @param {string} tableName
 * @returns {string}
 */
function buildTableNamePattern(schema, tableName) {
	const schemaPattern = `(?:"?${escapeRegex(schema)}"?\\.)?`;
	const tablePattern = `"?${escapeRegex(tableName)}"?`;
	return schemaPattern + tablePattern;
}

/**
 * Find ALTER TABLE statements that reference tables without a corresponding CREATE TABLE.
 * Checks both the target table and any REFERENCES clauses.
 * @param {string} sql - The SQL content to check
 * @returns {OrphanedAlterTable[]}
 */
export function findOrphanedAlterTables(sql) {
	// First, parse the SQL to get all defined tables
	const { tables } = parsePostgresSQL(sql);
	const definedTables = new Set(tables.map((t) => t.qualifiedName));

	/** @type {OrphanedAlterTable[]} */
	const orphaned = [];

	// Track which statements we've already flagged to avoid duplicates
	/** @type {Set<number>} */
	const flaggedPositions = new Set();

	// Find all ALTER TABLE statements using regex
	// Pattern: ALTER TABLE [IF EXISTS] [schema.]table ...;
	const alterTablePattern = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?("?\w+"?(?:\."?\w+"?)?)[^;]*;/gi;

	let match;
	while ((match = alterTablePattern.exec(sql)) !== null) {
		const tableRef = match[1];
		const qualifiedName = normalizeTableName(tableRef);
		const statement = match[0];

		// Check if the ALTER TABLE target doesn't exist
		if (!definedTables.has(qualifiedName)) {
			orphaned.push({
				tableName: qualifiedName,
				start: match.index,
				end: match.index + statement.length,
				statement
			});
			flaggedPositions.add(match.index);
			continue;
		}

		// Check if any REFERENCES clause points to a non-existent table
		const referencesPattern = /REFERENCES\s+("?\w+"?(?:\."?\w+"?)?)/gi;
		let refMatch;
		while ((refMatch = referencesPattern.exec(statement)) !== null) {
			const refTableName = normalizeTableName(refMatch[1]);
			if (!definedTables.has(refTableName) && !flaggedPositions.has(match.index)) {
				orphaned.push({
					tableName: refTableName,
					start: match.index,
					end: match.index + statement.length,
					statement
				});
				flaggedPositions.add(match.index);
				break; // Only flag once per statement
			}
		}
	}

	return orphaned;
}

/**
 * Normalize a table name reference to qualified form (schema.table).
 * @param {string} tableRef - Table reference like "schema.table", schema.table, or just table
 * @returns {string}
 */
function normalizeTableName(tableRef) {
	// Remove quotes and normalize
	const cleaned = tableRef.replace(/"/g, '');
	if (cleaned.includes('.')) {
		return cleaned.toLowerCase();
	}
	return `public.${cleaned.toLowerCase()}`;
}

/**
 * Remove orphaned ALTER TABLE statements from SQL content.
 * @param {string} sql - The SQL content
 * @param {OrphanedAlterTable[]} orphaned - The orphaned statements to remove
 * @returns {string}
 */
export function removeOrphanedAlterTables(sql, orphaned) {
	if (orphaned.length === 0) {
		return sql;
	}

	// Sort by position descending so we can remove from end to start
	const sorted = [...orphaned].sort((a, b) => b.start - a.start);

	let result = sql;
	for (const item of sorted) {
		result = removeRangeWithWhitespace(result, item.start, item.end);
	}

	return result.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
