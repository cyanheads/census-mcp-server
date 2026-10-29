/**
 * @fileoverview Tests for the escaping notice render the tools that quote caller or upstream text
 * declare as their `enrichmentTrailer`. The escaping is tabled here once; each tool's suite proves
 * only that the tool is wired to it.
 * @module tests/tools/notice-trailer.test
 */

import { describe, expect, it } from 'vitest';
import { renderNotice } from '@/mcp-server/tools/notice-trailer.js';
import { readBlockquotes } from '../helpers/markdown-readback.js';

describe('renderNotice', () => {
  it.each([
    ['emphasis and strong', 'No match for "*a* **b** _c_ __d__".'],
    ['a code span', 'No match for "`B19013_001E`".'],
    ['a link and an image', 'Saw [a](b) and ![c](d) here.'],
    ['raw HTML and an autolink', 'Got <b>x</b>, <https://example.com>, and <a@b.co>.'],
    ['an entity and a numeric reference', 'AT&T &copy; &#123; stay text.'],
    ['a GFM table row and strikethrough', 'a | b ~~gone~~ ~x~'],
    ['a backslash before punctuation', 'C:\\Users\\x and \\* and a\\'],
    ['a block marker opening the notice', '# not a heading'],
    ['a list marker opening the notice', '- not a list'],
    ['an ordered marker opening the notice', '1. not a list'],
    ['a quote marker opening the notice', '> not nested'],
    ['a thematic break', '***'],
    ['leading and trailing spaces', '  padded  '],
    ['a line break', 'first line\nsecond *line*'],
    ['a blank line between two lines', 'first\n\nsecond'],
    ['a closing line break', 'ends with a break\n'],
    ['an empty notice', ''],
  ])('reads %s back exactly under a CommonMark parse', (_name, notice) => {
    expect(readBlockquotes(renderNotice(notice))).toEqual([notice]);
  });

  it('reads CRLF and a lone CR back as LF, as the escaper normalizes them', () => {
    expect(readBlockquotes(renderNotice('a\r\nb\rc'))).toEqual(['a\nb\nc']);
  });

  it('quotes every line, so the notice stays one block quote', () => {
    const rendered = renderNotice('one\n- two\n\n# three');

    expect(rendered.split('\n').every((line) => line === '>' || line.startsWith('> '))).toBe(true);
    expect(readBlockquotes(rendered)).toHaveLength(1);
  });

  it('leaves text with no Markdown-active character as the framework renders it', () => {
    expect(renderNotice('No variables matched "median income" in acs/acs5 (2024).')).toBe(
      '> No variables matched "median income" in acs/acs5 (2024).',
    );
  });

  /** An underscore between two word characters cannot open emphasis, so codes copy out clean. */
  it('keeps an intraword underscore unescaped so a quoted code copies out as written', () => {
    expect(renderNotice('Pass CENSUS_API_KEY or B19013_001E.')).toBe(
      '> Pass CENSUS_API_KEY or B19013_001E.',
    );
  });

  it('escapes a Markdown-active query the framework would have rendered live', () => {
    expect(renderNotice('No variables matched "[B19013_001E]* `x` ~ _ |".')).toBe(
      '> No variables matched "\\[B19013_001E\\]\\* \\`x\\` \\~ \\_ \\|".',
    );
  });
});
