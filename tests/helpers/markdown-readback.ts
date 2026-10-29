/**
 * @fileoverview Reads Markdown back the way a client renders it, so a test can compare the text a
 * reader of `content[]` sees with the string `structuredContent` carries. Parses with markdown-it's
 * CommonMark preset plus the GFM table and strikethrough rules, so emphasis, code, links, raw HTML,
 * tables, and strikethrough all surface as markup rather than as the literal text.
 * @module tests/helpers/markdown-readback
 */

import MarkdownIt, { type Token } from 'markdown-it';

const md = new MarkdownIt('commonmark').enable(['table', 'strikethrough']);

/**
 * Inline tokens as the text a renderer shows. Every token that is not plain text or a line break
 * comes back as a `«type:content»` marker, so markup can never compare equal to the literal string.
 */
function inlineText(tokens: Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === 'text') return token.content;
      if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
      return `«${token.type}${token.content ? `:${token.content}` : ''}»`;
    })
    .join('');
}

/**
 * Every top-level block quote in `markdown`, each read back as plain text: paragraphs joined by a
 * blank line, and any other block inside the quote (a heading, a list, a nested quote) marked.
 */
export function readBlockquotes(markdown: string): string[] {
  const quotes: string[] = [];
  let depth = 0;
  let parts: string[] = [];
  for (const token of md.parse(markdown, {})) {
    if (token.type === 'blockquote_open' && depth++ === 0) {
      parts = [];
      continue;
    }
    if (token.type === 'blockquote_close' && --depth === 0) {
      quotes.push(parts.join('\n\n'));
      continue;
    }
    if (depth === 0) continue;
    if (token.type === 'inline') parts.push(inlineText(token.children ?? []));
    else if (token.type !== 'paragraph_open' && token.type !== 'paragraph_close') {
      parts.push(`«${token.type}»`);
    }
  }
  return quotes;
}

/** Every top-level paragraph in `markdown`, each read back as plain text, outside any container. */
export function readParagraphs(markdown: string): string[] {
  const paragraphs: string[] = [];
  let depth = 0;
  for (const token of md.parse(markdown, {})) {
    if (token.type === 'paragraph_open' || token.type === 'paragraph_close') continue;
    depth += token.nesting;
    if (token.type === 'inline' && depth === 0) paragraphs.push(inlineText(token.children ?? []));
  }
  return paragraphs;
}

/**
 * The enrichment notice a tool result's `content[]` carries, read back through a CommonMark parse.
 * The notice is the only block quote these tools emit, so anything other than exactly one fails.
 */
export function readNotice(result: { content: Array<{ type: string; text?: string }> }): string {
  const quotes = readBlockquotes(result.content.map((c) => c.text ?? '').join('\n'));
  if (quotes.length !== 1) {
    throw new Error(`Expected one block quote in content[], found ${quotes.length}.`);
  }
  return quotes[0] as string;
}
