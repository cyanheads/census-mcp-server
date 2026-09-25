/**
 * @fileoverview The per-variable value entry census_query_data and census_compare_geographies both
 * return, and how one renders in content[]. Shared so the two surfaces and the two tools cannot
 * describe the same cell differently.
 * @module mcp-server/tools/variable-entry
 */

import type { CensusFlag, CensusVariableValue } from '@/services/census-api/types.js';

/** One variable's value as the data tools return it in `rows[].variables`. */
export interface VariableEntry {
  estimate: number | null;
  flag?: CensusFlag;
  label: string;
  moe?: number | null;
  open_ended?: boolean;
  suppressed: boolean;
  suppression_reason?: string;
  value?: string;
}

/** Map a parsed value onto the output entry, under the label the variable cache resolved. */
export function toVariableEntry(value: CensusVariableValue, label: string): VariableEntry {
  return {
    estimate: value.estimate,
    ...(value.moe !== undefined && { moe: value.moe }),
    label,
    suppressed: value.suppressed,
    ...(value.suppressionReason && { suppression_reason: value.suppressionReason }),
    ...(value.openEnded && { open_ended: true }),
    ...(value.flag && { flag: value.flag }),
    ...(value.value !== undefined && { value: value.value }),
  };
}

/**
 * Render one entry as the markdown lines `format()` emits: the value — or why there is none —
 * with its margin, open-ended marker, and flag, then the label when it says more than the code.
 */
export function renderVariable(code: string, entry: VariableEntry): string[] {
  let text: string;
  if (entry.suppressed) {
    text = `Suppressed${entry.suppression_reason ? ` (${entry.suppression_reason})` : ''}${
      entry.flag ? ` [flag ${entry.flag.code}]` : ''
    }`;
  } else if (entry.value !== undefined) {
    text = entry.value;
  } else {
    const moe = entry.moe != null ? ` ± ${entry.moe.toLocaleString()}` : '';
    const openEnded = entry.open_ended
      ? " (open-ended: the median falls in the lowest or highest interval, so this figure is that interval's boundary)"
      : '';
    const flag = entry.flag ? ` [flag ${entry.flag.code}: ${entry.flag.meaning}]` : '';
    text = `${entry.estimate?.toLocaleString() ?? 'N/A'}${moe}${openEnded}${flag}`;
  }
  return [
    `- **${code}:** ${text}`,
    ...(entry.label && entry.label !== code ? [`  *${entry.label}*`] : []),
  ];
}
