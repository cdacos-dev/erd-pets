import { describe, it, expect } from 'vitest';

import {
  encodeShareLink,
  decodeShareLink,
  isShareSupported,
  SHARE_SIZE_WARN,
} from './shareLink.js';

const SAMPLE_SQL = `CREATE TABLE public.users (
  id integer PRIMARY KEY,
  email text NOT NULL,
  org_id integer
);

CREATE TABLE public.orgs (
  id integer PRIMARY KEY,
  name text NOT NULL
);

ALTER TABLE public.users
  ADD CONSTRAINT users_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs (id);
`;

const SAMPLE_DIAGRAM = JSON.stringify({
  sql: 'schema.sql',
  diagrams: [
    {
      id: 'main',
      title: 'Main',
      tables: [
        { name: 'public.users', x: 100, y: 50, color: '#ff0000' },
        { name: 'public.orgs', x: 400, y: 50 },
      ],
    },
  ],
});

describe('shareLink', () => {
  it('reports support in the test runtime (Node 22)', () => {
    expect(isShareSupported()).toBe(true);
  });

  it('round-trips a project through encode/decode', async () => {
    const project = { sql: SAMPLE_SQL, diagram: SAMPLE_DIAGRAM };
    const blob = await encodeShareLink(project);
    const decoded = await decodeShareLink(blob);
    expect(decoded).toEqual(project);
  });

  it('preserves unicode and special characters', async () => {
    const project = {
      sql: "-- café ☕ — naïve\nCREATE TABLE t (x text DEFAULT 'a\\'b');",
      diagram: JSON.stringify({ note: 'emoji 🐾 and "quotes"' }),
    };
    const decoded = await decodeShareLink(await encodeShareLink(project));
    expect(decoded).toEqual(project);
  });

  it('produces base64url output with no +, / or = characters', async () => {
    const blob = await encodeShareLink({ sql: SAMPLE_SQL, diagram: SAMPLE_DIAGRAM });
    expect(blob).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('compresses SQL-like input materially smaller than raw', async () => {
    // Repetitive SQL compresses well; assert the blob is smaller than the input.
    const sql = SAMPLE_SQL.repeat(20);
    const blob = await encodeShareLink({ sql, diagram: SAMPLE_DIAGRAM });
    expect(blob.length).toBeLessThan(sql.length);
  });

  it('throws on empty input', async () => {
    await expect(decodeShareLink('')).rejects.toThrow();
  });

  it('throws on garbage / truncated input', async () => {
    await expect(decodeShareLink('not-a-valid-blob!!!')).rejects.toThrow(
      /corrupted|unreadable/i
    );
    const blob = await encodeShareLink({ sql: SAMPLE_SQL, diagram: SAMPLE_DIAGRAM });
    const truncated = blob.slice(0, Math.floor(blob.length / 2));
    await expect(decodeShareLink(truncated)).rejects.toThrow();
  });

  it('throws on an unknown envelope version', async () => {
    // Hand-build a valid-but-future-version envelope and confirm it is rejected.
    const json = JSON.stringify({ v: 999, sql: 'x', diagram: 'y' });
    const bytes = new TextEncoder().encode(json);
    const cs = new CompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    let binary = '';
    for (const b of compressed) binary += String.fromCharCode(b);
    const blob = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await expect(decodeShareLink(blob)).rejects.toThrow(/version/i);
  });

  it('exposes a size-warning threshold', () => {
    expect(SHARE_SIZE_WARN).toBe(8000);
  });
});
