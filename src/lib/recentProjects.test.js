import { describe, it, expect } from 'vitest';

import { projectKey } from './recentProjects.js';

describe('projectKey', () => {
  it('strips the .erd-pets.json extension', () => {
    expect(projectKey('intercompany_isp.erd-pets.json')).toBe('intercompany_isp');
  });

  it('strips a plain .json extension', () => {
    expect(projectKey('schema.json')).toBe('schema');
  });

  it('slugifies spaces and punctuation', () => {
    expect(projectKey('My Cool Schema (v2).erd-pets.json')).toBe('my-cool-schema-v2');
  });

  it('preserves underscores and collapses other separators', () => {
    expect(projectKey('Foo_Bar..Baz.json')).toBe('foo_bar-baz');
  });

  it('trims leading and trailing separators', () => {
    expect(projectKey('--weird--.json')).toBe('weird');
  });

  it('falls back to a default when nothing usable remains', () => {
    expect(projectKey('.erd-pets.json')).toBe('project');
    expect(projectKey('!!!.json')).toBe('project');
  });
});
