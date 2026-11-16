/**
 * @fileoverview Tests for the per-variable entry census_query_data and census_compare_geographies
 * both return: every digit of a number reaching content[] whatever the host locale, and the
 * `variable_labels` map with the legend that renders it. Tabled here once; each tool's suite proves
 * only that the tool is wired to them.
 * @module tests/tools/variable-entry.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  renderVariable,
  renderVariableLabels,
  type VariableEntry,
  variableLabels,
} from '@/mcp-server/tools/variable-entry.js';
import { readVariableLabels } from '../helpers/variable-labels-readback.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** The text a rendered entry gives its value, with the `- **X:** ` prefix taken off. */
const valueText = (entry: VariableEntry) => {
  const line = renderVariable('X', entry);
  expect(line.startsWith('- **X:** ')).toBe(true);
  return line.slice('- **X:** '.length);
};

/** A rendered number read back as a reader copies it: the thousands separators dropped. */
const readBack = (text: string) => text.replaceAll(',', '');

/**
 * Make `locale` the host default for the number formatting a renderer can reach, as on a server
 * started under another locale. Bun ignores LANG, and Node reads it once at startup, so the default
 * is swapped in place rather than through the environment.
 */
function useDefaultLocale(locale: string) {
  const unpinned = Number.prototype.toLocaleString;
  vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (
    this: number,
    locales?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions,
  ) {
    return unpinned.call(this, locales ?? locale, options);
  });
  const NumberFormat = Intl.NumberFormat;
  vi.spyOn(Intl, 'NumberFormat').mockImplementation(
    class extends NumberFormat {
      constructor(locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
        super(locales ?? locale, options);
      }
    } as never,
  );
}

describe('renderVariable gives content[] every digit structuredContent carries', () => {
  /**
   * Each value read back must equal what `JSON.stringify` writes for it — the digits
   * `structuredContent` carries, no fewer and no others, so `0.3` cannot come back as `0.29999…`.
   */
  it.each([
    ['a double with no exact binary form', 0.3],
    ['0.1', 0.1],
    ['a four-decimal Gini index', 0.4691],
    ['its four-decimal margin of error', 0.0018],
    ['an internal-point latitude', 47.4905518],
    ['an internal-point longitude', -121.8339765],
    ['a whole land area', 84],
    ['a land area past a thousand', 2115.696],
    ['a sum with a binary rounding tail', 0.1 + 0.2],
    ['the largest safe integer', Number.MAX_SAFE_INTEGER],
    ['a land area in square meters', 1_478_839_695_958],
    ['a negative estimate', -5],
    ['zero, as the controlled-estimate sentinel decodes', 0],
    ['a number JSON writes with an exponent', 1e21],
    ['a small number JSON writes with an exponent', 1.5e-7],
  ])('%s (%d)', (_name, value) => {
    expect(readBack(valueText({ estimate: value, suppressed: false }))).toBe(JSON.stringify(value));
    const [, margin] = valueText({ estimate: 1, moe: value, suppressed: false }).split(' ± ');
    expect(readBack(margin as string)).toBe(JSON.stringify(value));
  });

  it.each([
    [{ estimate: 0.4691, moe: 0.0018, suppressed: false }, '0.4691 ± 0.0018'],
    [{ estimate: 2115.696, suppressed: false }, '2,115.696'],
    [{ estimate: 47.4905518, suppressed: false }, '47.4905518'],
    [{ estimate: -121.8339765, suppressed: false }, '-121.8339765'],
    [{ estimate: 9_007_199_254_740_991, suppressed: false }, '9,007,199,254,740,991'],
    [{ estimate: -1234567.5, moe: 0, suppressed: false }, '-1,234,567.5 ± 0'],
    [{ estimate: 1140843, moe: 1234, suppressed: false }, '1,140,843 ± 1,234'],
    [{ estimate: 0.3, suppressed: false }, '0.3'],
  ])('groups only the integer digits, en-US style: %j', (entry, expected) => {
    expect(valueText(entry)).toBe(expected);
  });

  it('a number with no estimate still reads N/A', () => {
    expect(valueText({ estimate: null, suppressed: false })).toBe('N/A');
  });

  it.each(['en-US', 'de-DE', 'fr-FR', 'hi-IN'])(
    'renders the same text with %s as the host locale',
    (locale) => {
      useDefaultLocale(locale);
      // The swap took: an unpinned format now follows the host locale.
      expect((1234.5).toLocaleString()).toBe(new Intl.NumberFormat(locale).format(1234.5));

      expect(
        renderVariable('B19083_001E', { estimate: 0.4691, moe: 0.0018, suppressed: false }),
      ).toBe('- **B19083_001E:** 0.4691 ± 0.0018');
      expect(renderVariable('AREALAND_SQMI', { estimate: 2115.696, suppressed: false })).toBe(
        '- **AREALAND_SQMI:** 2,115.696',
      );
      expect(renderVariable('AREALAND', { estimate: 5_479_626_341, suppressed: false })).toBe(
        '- **AREALAND:** 5,479,626,341',
      );
    },
  );

  it('the non-US host locales above do format differently when unpinned', () => {
    useDefaultLocale('de-DE');
    expect((2115.696).toLocaleString()).toBe('2.115,696');
  });
});

describe('variableLabels', () => {
  const labels = new Map([
    ['B19013_001E', { label: 'Estimate!!Median household income' }],
    ['B19013_001M', { label: 'Margin of Error!!Median household income' }],
    ['GEO_ID', { label: 'Geography' }],
    ['NO_LABEL', { label: '' }],
  ]);

  it('maps each code to its label, in the order the codes are given', () => {
    const map = variableLabels(['GEO_ID', 'B19013_001M', 'B19013_001E'], labels);

    expect(Object.keys(map)).toEqual(['GEO_ID', 'B19013_001M', 'B19013_001E']);
    expect(map).toEqual({
      GEO_ID: 'Geography',
      B19013_001M: 'Margin of Error!!Median household income',
      B19013_001E: 'Estimate!!Median household income',
    });
  });

  it('gives no entry to a code with no label: an attribute column, or an empty label', () => {
    const map = variableLabels(['B19013_001E', 'B19013_001EA', 'EMP_F', 'NO_LABEL'], labels);

    expect(map).toEqual({ B19013_001E: 'Estimate!!Median household income' });
    expect(Object.hasOwn(map, 'B19013_001EA')).toBe(false);
    expect(Object.hasOwn(map, 'NO_LABEL')).toBe(false);
  });

  it('is empty when no code has a label', () => {
    expect(variableLabels(['B19013_001EA'], labels)).toEqual({});
    expect(variableLabels([], labels)).toEqual({});
  });

  it('keys a code that names an Object.prototype member as an ordinary entry', () => {
    const map = variableLabels(
      ['__proto__', 'constructor'],
      new Map([
        ['__proto__', { label: 'first' }],
        ['constructor', { label: 'second' }],
      ]),
    );

    expect(JSON.stringify(map)).toBe('{"__proto__":"first","constructor":"second"}');
  });
});

describe('renderVariableLabels', () => {
  it('renders nothing for an empty map', () => {
    expect(renderVariableLabels({})).toEqual([]);
  });

  it('heads the legend and lists each code with its label, in map order', () => {
    expect(
      renderVariableLabels({
        B19013_001E: 'Estimate!!Median household income',
        B19013_001M: 'Margin of Error!!Median household income',
      }),
    ).toEqual([
      '**Variable labels**',
      '- **B19013_001E:** Estimate!!Median household income',
      '- **B19013_001M:** Margin of Error!!Median household income',
    ]);
  });

  it('reads back exactly under a CommonMark parse, Markdown-active labels included', () => {
    const map = {
      B19013_001E: 'Estimate!!Median household income in the past 12 months (in 2024 dollars)',
      PAYANN: 'Annual payroll ($1,000)',
      EMPH: 'a *b* _c_ `d` [e](f) <b>g</b> &amp; ~~h~~ | i',
      LEAD: '# not a heading',
      CP03_2024to2019_062SS: '- not a list',
    };

    expect(readVariableLabels(renderVariableLabels(map).join('\n'))).toEqual(map);
  });
});
