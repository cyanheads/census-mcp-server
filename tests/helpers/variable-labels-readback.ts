/**
 * @fileoverview Reads the variable-label legend of a census_query_data or census_compare_geographies
 * result back the way a client renders it, so a test can compare the code → label pairs a reader of
 * `content[]` sees with the `variable_labels` map `structuredContent` carries.
 * @module tests/helpers/variable-labels-readback
 */

import MarkdownIt, { type Token } from 'markdown-it';

const md = new MarkdownIt('commonmark').enable(['table', 'strikethrough']);

/** The paragraph text that heads the legend. */
const LEGEND_HEADING = '«strong_open»Variable labels«strong_close»';

/** Inline tokens as the text a renderer shows, every other token kept as a `«type»` marker. */
function inlineText(tokens: Token[]): string {
  return tokens
    .map((token) => (token.type === 'text' ? token.content : `«${token.type}»`))
    .join('');
}

/**
 * The legend's code → label pairs, in the order they are listed, under a CommonMark parse — or
 * `undefined` when `markdown` holds no legend. Each item must read as a bold `CODE:` followed by a
 * space and the label as plain text: markup anywhere in the label comes back as a `«type»` marker,
 * so it can never compare equal to the string `structuredContent` carries.
 */
export function readVariableLabels(markdown: string): Record<string, string> | undefined {
  const tokens = md.parse(markdown, {});
  const heading = tokens.findIndex(
    (token, i) =>
      token.type === 'inline' &&
      tokens[i - 1]?.type === 'paragraph_open' &&
      inlineText(token.children ?? []) === LEGEND_HEADING,
  );
  if (heading === -1) return;

  const pairs: Record<string, string> = Object.create(null);
  let depth = 0;
  for (const token of tokens.slice(heading + 2)) {
    if (depth === 0 && token.type !== 'bullet_list_open') break;
    depth += token.nesting;
    if (token.type === 'inline') {
      // An emphasis delimiter the parser consumed can leave an empty text token behind.
      const children = (token.children ?? []).filter((t) => t.type !== 'text' || t.content !== '');
      const [open, code, close, ...rest] = children;
      const text = inlineText(rest);
      if (
        open?.type !== 'strong_open' ||
        code?.type !== 'text' ||
        !code.content.endsWith(':') ||
        close?.type !== 'strong_close' ||
        !text.startsWith(' ')
      ) {
        throw new Error(`Legend item does not read as "**CODE:** label": ${inlineText(children)}`);
      }
      pairs[code.content.slice(0, -1)] = text.slice(1);
    }
    if (depth === 0) break;
  }
  return pairs;
}
