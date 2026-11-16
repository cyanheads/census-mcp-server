/**
 * @fileoverview The per-variable value entry census_query_data and census_compare_geographies both
 * return, the `variable_labels` map that names each variable once per response, and how both render
 * in content[]. Shared so the two surfaces and the two tools cannot describe the same cell or the
 * same variable differently.
 * @module mcp-server/tools/variable-entry
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import type { CensusFlag, CensusVariableValue } from '@/services/census-api/types.js';

/** One variable's value as the data tools return it in `rows[].variables`. */
export interface VariableEntry {
  estimate: number | null;
  flag?: CensusFlag;
  moe?: number | null;
  open_ended?: boolean;
  suppressed: boolean;
  suppression_reason?: string;
  value?: string;
}

/** Map a parsed value onto the output entry. */
export function toVariableEntry(value: CensusVariableValue): VariableEntry {
  return {
    estimate: value.estimate,
    ...(value.moe !== undefined && { moe: value.moe }),
    suppressed: value.suppressed,
    ...(value.suppressionReason && { suppression_reason: value.suppressionReason }),
    ...(value.openEnded && { open_ended: true }),
    ...(value.flag && { flag: value.flag }),
    ...(value.value !== undefined && { value: value.value }),
  };
}

/**
 * The `variable_labels` map: each of `codes` that the dataset labels, mapped to that label, in the
 * order given. `codes` is every column the rows key, in their order — taken from the request rather
 * than the rows, so every page of one query, one past the end included, carries the same map. A
 * code with no label in `labels` — an attribute column such as `B19013_001EA` or `EMP_F`, which
 * variables.json lists only inside another entry — gets no entry.
 */
export function variableLabels(
  codes: readonly string[],
  labels: ReadonlyMap<string, { label: string }>,
): Record<string, string> {
  // No prototype, so a code named like an Object.prototype member is an ordinary key.
  const map: Record<string, string> = Object.create(null);
  for (const code of codes) {
    const label = labels.get(code)?.label;
    if (label) map[code] = label;
  }
  return map;
}

/**
 * Render the `variable_labels` map as the legend `format()` places ahead of the rows, or nothing for
 * an empty map. Labels are upstream text, so each is escaped to read back exactly under CommonMark.
 */
export function renderVariableLabels(labels: Record<string, string>): string[] {
  const entries = Object.entries(labels);
  if (entries.length === 0) return [];
  return [
    '**Variable labels**',
    ...entries.map(([code, label]) => `- **${code}:** ${escapeMarkdownInline(label)}`),
  ];
}

/**
 * A number as `structuredContent` carries it — the shortest round-trip digits `JSON.stringify`
 * writes — with the integer digits grouped in threes. Built on `String` rather than `Intl`, whose
 * fraction digits stop at three by default and whose separators follow the host locale.
 */
function formatNumber(value: number): string {
  const text = String(value);
  // An exponent form (|value| ≥ 1e21 or < 1e-6) is left as JSON writes it.
  if (text.includes('e')) return text;
  const [integer = '', fraction] = text.split('.');
  // At most 21 digits and a sign, since a larger magnitude takes the exponent form above.
  const grouped = integer.replace(/\B(?=(\d{3})+$)/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/**
 * Render one entry as the markdown line `format()` emits: the value — or why there is none — with
 * its margin, open-ended marker, and flag.
 */
export function renderVariable(code: string, entry: VariableEntry): string {
  let text: string;
  if (entry.suppressed) {
    text = `Suppressed${entry.suppression_reason ? ` (${entry.suppression_reason})` : ''}${
      entry.flag ? ` [flag ${entry.flag.code}]` : ''
    }`;
  } else if (entry.value !== undefined) {
    text = entry.value;
  } else {
    const moe = entry.moe != null ? ` ± ${formatNumber(entry.moe)}` : '';
    const openEnded = entry.open_ended
      ? " (open-ended: the median falls in the lowest or highest interval, so this figure is that interval's boundary)"
      : '';
    const flag = entry.flag ? ` [flag ${entry.flag.code}: ${entry.flag.meaning}]` : '';
    text = `${entry.estimate === null ? 'N/A' : formatNumber(entry.estimate)}${moe}${openEnded}${flag}`;
  }
  return `- **${code}:** ${text}`;
}
