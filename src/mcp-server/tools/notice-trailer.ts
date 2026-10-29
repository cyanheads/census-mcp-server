/**
 * @fileoverview How a tool's `notice` enrichment renders in content[] when it can quote caller or
 * upstream text. The framework renders a notice as live Markdown, so a quoted `*x*` or `[a](b)`
 * shows up as emphasis or a link; this renders the same block quote with the text escaped, while
 * `structuredContent.notice` keeps the raw string.
 * @module mcp-server/tools/notice-trailer
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/**
 * Render a notice as the framework's block quote — every line quoted, a blank one as `>` — over
 * {@link escapeMarkdownInline}, so a CommonMark parse reads back exactly the notice text. No notice
 * on this server carries authored Markdown, so escaping all of it loses nothing. The escaper joins
 * lines with hard breaks, so a multi-line notice stays one paragraph rather than one per line.
 *
 * Wire it as a definition's `enrichmentTrailer: { notice: { render: renderNotice } }`. Escaping in
 * the handler instead would put the backslashes into `structuredContent.notice` too.
 */
export function renderNotice(notice: string): string {
  return escapeMarkdownInline(notice)
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}
