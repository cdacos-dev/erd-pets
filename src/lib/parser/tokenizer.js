/** @import { Token, TokenType } from './types.js' */

const KEYWORDS = new Set([
	'ADD',
	'ALTER',
	'ALWAYS',
	'AND',
	'AS',
	'BIGINT',
	'BOOLEAN',
	'CHAR',
	'CHARACTER',
	'CONSTRAINT',
	'CREATE',
	'DATABASE',
	'DEFAULT',
	'EXISTS',
	'FOREIGN',
	'FROM',
	'GENERATED',
	'IDENTITY',
	'IF',
	'INTEGER',
	'JSONB',
	'KEY',
	'NOT',
	'NULL',
	'ONLY',
	'PRIMARY',
	'REFERENCES',
	'SCHEMA',
	'SELECT',
	'SET',
	'SYSTEM',
	'TABLE',
	'TEXT',
	'TIME',
	'TIMESTAMP',
	'TIMESTAMPTZ',
	'UNIQUE',
	'VARCHAR',
	'VARYING',
	'WITH',
	'WITHOUT',
	'ZONE'
]);

/**
 * Tokenizes SQL text into an array of tokens
 * @param {string} sql - The SQL text to tokenize
 * @returns {Token[]} Array of tokens
 */
export function tokenize(sql) {
	/** @type {Token[]} */
	const tokens = [];
	let pos = 0;
	let line = 1;
	let column = 1;

	while (pos < sql.length) {
		const char = sql[pos];

		// Newline
		if (char === '\n') {
			pos++;
			line++;
			column = 1;
			continue;
		}

		// Whitespace (not newline)
		if (/\s/.test(char)) {
			pos++;
			column++;
			continue;
		}

		// Line comment
		if (char === '-' && sql[pos + 1] === '-') {
			const start = pos;
			pos += 2;
			while (pos < sql.length && sql[pos] !== '\n') {
				pos++;
			}
			column += pos - start;
			continue;
		}

		// Block comment
		if (char === '/' && sql[pos + 1] === '*') {
			pos += 2;
			column += 2;
			while (pos < sql.length - 1) {
				if (sql[pos] === '*' && sql[pos + 1] === '/') {
					pos += 2;
					column += 2;
					break;
				}
				if (sql[pos] === '\n') {
					line++;
					column = 1;
				} else {
					column++;
				}
				pos++;
			}
			continue;
		}

		// Quoted identifier
		if (char === '"') {
			const startLine = line;
			const startColumn = column;
			pos++;
			column++;
			let value = '';
			while (pos < sql.length) {
				if (sql[pos] === '"') {
					if (sql[pos + 1] === '"') {
						// Escaped quote
						value += '"';
						pos += 2;
						column += 2;
					} else {
						pos++;
						column++;
						break;
					}
				} else {
					value += sql[pos];
					pos++;
					column++;
				}
			}
			tokens.push({
				type: 'QUOTED_IDENTIFIER',
				value,
				line: startLine,
				column: startColumn
			});
			continue;
		}

		// String literal
		if (char === "'") {
			const startLine = line;
			const startColumn = column;
			pos++;
			column++;
			let value = '';
			while (pos < sql.length) {
				if (sql[pos] === "'") {
					if (sql[pos + 1] === "'") {
						// Escaped quote
						value += "'";
						pos += 2;
						column += 2;
					} else {
						pos++;
						column++;
						break;
					}
				} else {
					value += sql[pos];
					pos++;
					column++;
				}
			}
			tokens.push({
				type: 'STRING',
				value,
				line: startLine,
				column: startColumn
			});
			continue;
		}

		// Number
		if (/[0-9]/.test(char)) {
			const startLine = line;
			const startColumn = column;
			let value = '';
			while (pos < sql.length && /[0-9.]/.test(sql[pos])) {
				value += sql[pos];
				pos++;
				column++;
			}
			tokens.push({
				type: 'NUMBER',
				value,
				line: startLine,
				column: startColumn
			});
			continue;
		}

		// Identifier or keyword
		if (/[a-zA-Z_]/.test(char)) {
			const startLine = line;
			const startColumn = column;
			let value = '';
			while (pos < sql.length && /[a-zA-Z0-9_]/.test(sql[pos])) {
				value += sql[pos];
				pos++;
				column++;
			}
			const upperValue = value.toUpperCase();
			if (KEYWORDS.has(upperValue)) {
				tokens.push({
					type: 'KEYWORD',
					value: upperValue,
					line: startLine,
					column: startColumn
				});
			} else {
				// Unquoted identifiers fold to lowercase
				tokens.push({
					type: 'IDENTIFIER',
					value: value.toLowerCase(),
					line: startLine,
					column: startColumn
				});
			}
			continue;
		}

		// Punctuation
		if ('(),;.[]'.includes(char)) {
			tokens.push({
				type: 'PUNCTUATION',
				value: char,
				line,
				column
			});
			pos++;
			column++;
			continue;
		}

		// Operators
		if ('<>=!+-*/:|'.includes(char)) {
			const startLine = line;
			const startColumn = column;
			let value = char;
			pos++;
			column++;
			// Handle two-character operators
			if (pos < sql.length) {
				const next = sql[pos];
				if (
					(char === '<' && (next === '>' || next === '=')) ||
					(char === '>' && next === '=') ||
					(char === '!' && next === '=') ||
					(char === ':' && next === ':')
				) {
					value += next;
					pos++;
					column++;
				}
			}
			tokens.push({
				type: 'OPERATOR',
				value,
				line: startLine,
				column: startColumn
			});
			continue;
		}

		// Unknown character - skip
		pos++;
		column++;
	}

	tokens.push({
		type: 'EOF',
		value: '',
		line,
		column
	});

	return tokens;
}

/**
 * Creates a token stream for easier parsing
 */
export class TokenStream {
	/** @type {Token[]} */
	#tokens;
	/** @type {number} */
	#pos = 0;

	/**
	 * @param {Token[]} tokens
	 */
	constructor(tokens) {
		this.#tokens = tokens;
	}

	/**
	 * Returns the current token without advancing
	 * @returns {Token}
	 */
	peek() {
		return this.#tokens[this.#pos];
	}

	/**
	 * Look ahead n tokens
	 * @param {number} n
	 * @returns {Token}
	 */
	lookAhead(n) {
		const idx = this.#pos + n;
		if (idx >= this.#tokens.length) {
			return this.#tokens[this.#tokens.length - 1]; // EOF
		}
		return this.#tokens[idx];
	}

	/**
	 * Returns current token and advances
	 * @returns {Token}
	 */
	next() {
		return this.#tokens[this.#pos++];
	}

	/**
	 * Check if current token matches type and optionally value
	 * @param {TokenType} type
	 * @param {string} [value]
	 * @returns {boolean}
	 */
	is(type, value) {
		const token = this.peek();
		if (token.type !== type) return false;
		if (value !== undefined && token.value !== value) return false;
		return true;
	}

	/**
	 * Consume a token if it matches, otherwise throw
	 * @param {TokenType} type
	 * @param {string} [value]
	 * @returns {Token}
	 */
	expect(type, value) {
		const token = this.next();
		if (token.type !== type) {
			throw new Error(`Expected ${type} but got ${token.type} at line ${token.line}`);
		}
		if (value !== undefined && token.value !== value) {
			throw new Error(`Expected "${value}" but got "${token.value}" at line ${token.line}`);
		}
		return token;
	}

	/**
	 * Consume a token if it matches, otherwise return null
	 * @param {TokenType} type
	 * @param {string} [value]
	 * @returns {Token | null}
	 */
	match(type, value) {
		if (this.is(type, value)) {
			return this.next();
		}
		return null;
	}

	/**
	 * Check if at end of tokens
	 * @returns {boolean}
	 */
	isEOF() {
		return this.peek().type === 'EOF';
	}

	/**
	 * Get current line number
	 * @returns {number}
	 */
	line() {
		return this.peek().line;
	}

	/**
	 * Save current position for backtracking
	 * @returns {number}
	 */
	save() {
		return this.#pos;
	}

	/**
	 * Restore to saved position
	 * @param {number} pos
	 */
	restore(pos) {
		this.#pos = pos;
	}
}
