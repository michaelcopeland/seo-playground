import { describe, it, expect } from 'vitest';
import { parseCollapsedSections } from './sidebar';

describe('parseCollapsedSections', () => {
  it('reads the encoded cookie value', () => {
    expect(parseCollapsedSections('backlinks%2Cai')).toEqual(['backlinks', 'ai']);
  });

  it('treats a missing, empty or malformed cookie as nothing collapsed', () => {
    expect(parseCollapsedSections(undefined)).toEqual([]);
    expect(parseCollapsedSections('')).toEqual([]);
    expect(parseCollapsedSections('%E0%A4%A')).toEqual([]);
  });
});
