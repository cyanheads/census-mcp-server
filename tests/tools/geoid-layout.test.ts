/**
 * @fileoverview The GEOID layout table and the reading of a geography_fips list against a scope,
 * tabled once at their own seam: which levels a GEOID is read at, the parents and code width each
 * carries, when a member is sent as its level code, sent as written, or fills in a parent, and the
 * one vintage (dec/pl 2000) that lists a whole-number tract by 4 digits. The data tools' tests
 * prove only the wiring.
 * @module tests/tools/geoid-layout.test
 */

import { describe, expect, it } from 'vitest';
import {
  describeShortenedTracts,
  GEOID_LEVELS,
  type GeoidScope,
  listedForm,
  readGeoids,
  splitGeoid,
  type Vintage,
} from '@/mcp-server/tools/geoid-layout.js';

const NO_SCOPE: GeoidScope = { state: undefined, county: undefined, tract: undefined };
const scope = (given: Partial<GeoidScope>): GeoidScope => ({ ...NO_SCOPE, ...given });

/** A vintage that lists every tract in 6 digits, as all but dec/pl 2000 do. */
const ACS: Vintage = { dataset: 'acs/acs5', year: 2022 };
/** The one vintage that lists a tract whose code ends in 00 by its first 4 digits. */
const PL_2000: Vintage = { dataset: 'dec/pl', year: 2000 };

describe('splitGeoid — the levels a GEOID is read at', () => {
  it('reads a GEOID at exactly the nine levels whose GEOID carries a fixed parent chain', () => {
    expect(GEOID_LEVELS).toEqual([
      'county',
      'place',
      'school district (unified)',
      'economic place',
      'congressional district',
      'county subdivision',
      'tract',
      'block group',
      'block',
    ]);
  });

  it.each([
    ['county', '53053', { state: '53' }, '053'],
    ['place', '5363000', { state: '53' }, '63000'],
    ['school district (unified)', '5303840', { state: '53' }, '03840'],
    ['economic place', '5300003180', { state: '53' }, '00003180'],
    ['congressional district', '5309', { state: '53' }, '09'],
    ['county subdivision', '0900133620', { state: '09', county: '001' }, '33620'],
    ['tract', '53033007101', { state: '53', county: '033' }, '007101'],
    ['block group', '530330071011', { state: '53', county: '033', tract: '007101' }, '1'],
    ['block', '530330071011000', { state: '53', county: '033', tract: '007101' }, '1000'],
  ])('reads a %s GEOID %j as its parents and its code', (level, member, parents, code) => {
    expect(splitGeoid(level, member, ACS)).toEqual({ parents, code });
  });

  it.each([
    ['County', '53053'],
    [' tract ', '53033007101'],
    ['BLOCK GROUP', '530330071011'],
  ])('matches the level name %j regardless of case and surrounding space', (level, member) => {
    expect(splitGeoid(level, member, ACS)).toBeDefined();
  });

  it.each([
    ['county', '053', 'a bare level code'],
    ['county', '5305', 'one digit short'],
    ['county', '530533', 'one digit long'],
    ['place', '53545', 'a bare place code, even one starting with a state code'],
    ['tract', '5303300710', 'one digit short'],
    ['tract', '530330071011', 'one digit long'],
    ['block group', '1', 'a bare block group code'],
    ['block', '53033007101100', 'one digit short'],
    ['county', '5305a', 'not all digits'],
    ['county', ' 53053', 'untrimmed'],
    ['county', '*', 'a wildcard'],
    ['county', '', 'empty'],
    ['state', '53', 'a level whose GEOID is its code'],
    ['zip code tabulation area', '5398109', 'a level with no layout'],
    ['state legislative district (upper chamber)', '53001', 'a level with no layout'],
    ['school district (elementary)', '5303840', 'a level with no layout'],
  ])('reads %s %j as no GEOID: %s', (level, member) => {
    expect(splitGeoid(level, member, ACS)).toBeUndefined();
  });
});

describe('readGeoids — a geography_fips list read against the scope', () => {
  it.each([
    ['county', '053', scope({ state: '53' }), 'a bare code'],
    ['county', ' 053 , 061', scope({ state: '53' }), 'bare codes with spaces'],
    ['county', '*', scope({ state: '53' }), 'a wildcard'],
    ['county', '53053', scope({ state: '*' }), 'a GEOID under a "*" parent'],
    ['county', '53053,061', NO_SCOPE, 'a GEOID beside a bare code, with no parent'],
    ['county', '53033,06037', NO_SCOPE, 'GEOIDs of two states, with no parent'],
    ['state', '06, 53', NO_SCOPE, 'a level with no layout'],
    ['zip code tabulation area', '5398109', NO_SCOPE, 'a level with no layout'],
  ])('sends %s %j exactly as written: %s', (level, fips, given) => {
    const reading = readGeoids(level, fips, given, ACS);

    expect(reading.geographyFips).toBe(fips);
    expect(reading.members.every((member) => member.sent === member.given)).toBe(true);
    expect(reading.members.some((member) => member.conflict)).toBe(false);
  });

  it.each([
    ['county', '53053', scope({ state: '53' }), '053', scope({ state: '53' })],
    ['county', '53053', NO_SCOPE, '053', scope({ state: '53' })],
    ['county', '53053,53061', NO_SCOPE, '053,061', scope({ state: '53' })],
    ['county', '53053,061', scope({ state: '53' }), '053,061', scope({ state: '53' })],
    ['county', '53053,053', scope({ state: '53' }), '053', scope({ state: '53' })],
    ['county', ' 53053 ', NO_SCOPE, '053', scope({ state: '53' })],
    [
      'tract',
      '29213480108',
      scope({ state: '29' }),
      '480108',
      scope({ state: '29', county: '213' }),
    ],
    ['tract', '53033007101', NO_SCOPE, '007101', scope({ state: '53', county: '033' })],
    [
      'block group',
      '530330071011',
      scope({ state: '53', county: '033' }),
      '1',
      scope({ state: '53', county: '033', tract: '007101' }),
    ],
    [
      'block',
      '530330071011000,530330071011001',
      NO_SCOPE,
      '1000,1001',
      scope({ state: '53', county: '033', tract: '007101' }),
    ],
    ['county subdivision', '0900133620', NO_SCOPE, '33620', scope({ state: '09', county: '001' })],
  ])('sends %s %j under %j as %j, with the scope %j', (level, fips, given, sent, expectedScope) => {
    const reading = readGeoids(level, fips, given, ACS);

    expect(reading.geographyFips).toBe(sent);
    expect(reading.scope).toEqual(expectedScope);
    expect(reading.disagreements.size).toBe(0);
  });

  it('keeps each distinct member as written beside what is sent for it', () => {
    expect(readGeoids('county', '53053, 053,53053', scope({ state: '53' }), ACS).members).toEqual([
      { given: '53053', sent: '053' },
      { given: '053', sent: '053' },
    ]);
  });

  it('passes an empty member through as written beside a GEOID it reads', () => {
    const reading = readGeoids('county', '53053,', scope({ state: '53' }), ACS);

    expect(reading.geographyFips).toBe('053,');
    expect(reading.members).toEqual([
      { given: '53053', sent: '053' },
      { given: '', sent: '' },
    ]);
  });

  it.each([
    ['county', '06037', scope({ state: '53' }), ['state'], '037'],
    ['tract', '53033007101', scope({ state: '53', county: '061' }), ['county'], '007101'],
    ['tract', '06037007101', scope({ state: '53', county: '033' }), ['state', 'county'], '007101'],
    [
      'block',
      '530330071011000',
      scope({ state: '53', county: '033', tract: '007102' }),
      ['tract'],
      '1000',
    ],
    ['tract', '06037007101', scope({ state: '53', county: '*' }), ['state'], '007101'],
  ])(
    'sends %s %j, which contradicts %j, as written, recording the parents %j and code %j',
    (level, fips, given, parents, code) => {
      const reading = readGeoids(level, fips, given, ACS);

      expect(reading.geographyFips).toBe(fips);
      const [member] = reading.members;
      expect(member?.sent).toBe(fips);
      expect(member?.conflict?.parents).toEqual(parents);
      expect(member?.conflict?.geoid).toEqual(splitGeoid(level, fips, ACS));
      expect(member?.conflict?.geoid.code).toBe(code);
    },
  );

  it('reads the members that match beside the one that contradicts', () => {
    const reading = readGeoids('county', '53053,06037', scope({ state: '53' }), ACS);

    expect(reading.geographyFips).toBe('053,06037');
    expect(reading.members.map((member) => member.conflict?.parents)).toEqual([
      undefined,
      ['state'],
    ]);
  });

  it('records each omitted parent GEOIDs name several codes for, in order of first mention', () => {
    const reading = readGeoids('county', '53033,06037,53061', NO_SCOPE, ACS);

    expect([...reading.disagreements]).toEqual([['state', ['53', '06']]]);
    expect(reading.scope).toEqual(NO_SCOPE);
  });

  /**
   * Below the first parent, an omitted parent is read on its own: GEOIDs that agree on the state
   * fill it in even while they name two counties, and a member stays as written while any parent
   * it carries is still missing.
   */
  it('fills in the parent tract GEOIDs agree on and records the one they split on', () => {
    const reading = readGeoids('tract', '53033007101,53061050100', NO_SCOPE, ACS);

    expect(reading.scope).toEqual(scope({ state: '53' }));
    expect([...reading.disagreements]).toEqual([['county', ['033', '061']]]);
    expect(reading.geographyFips).toBe('53033007101,53061050100');
    expect(reading.members.every((member) => !member.conflict)).toBe(true);
  });

  it('fills in an agreed parent even when every member contradicts another', () => {
    const reading = readGeoids('tract', '53033007101,53033007102', scope({ state: '06' }), ACS);

    expect(reading.scope).toEqual(scope({ state: '06', county: '033' }));
    expect(reading.geographyFips).toBe('53033007101,53033007102');
    expect(reading.members.map((member) => member.conflict?.parents)).toEqual([
      ['state'],
      ['state'],
    ]);
  });

  it('fills in no parent from a list that mixes a GEOID with a bare code', () => {
    const reading = readGeoids('tract', '53033007101,007102', NO_SCOPE, ACS);

    expect(reading.scope).toEqual(NO_SCOPE);
    expect(reading.disagreements.size).toBe(0);
    expect(reading.geographyFips).toBe('53033007101,007102');
  });

  it('records the contradicted scope code beside the parent a GEOID contradicts', () => {
    const [member] = readGeoids(
      'tract',
      '06037007101',
      scope({ state: '53', county: '033' }),
      ACS,
    ).members;

    expect(member?.conflict?.scope).toEqual({ state: '53', county: '033' });
  });

  /** Only the dataset and the year together shorten: either one alone leaves the 6 digits. */
  it.each([
    [ACS, 0],
    [{ dataset: 'dec/pl', year: 2010 }, 0],
    [{ dataset: 'nonemp', year: 2000 }, 0],
    [PL_2000, 1],
  ])('reads tract "53033007100" on %j with %i tract codes shortened', (vintage, size) => {
    expect(readGeoids('tract', '53033007100', NO_SCOPE, vintage).shortened.size).toBe(size);
  });
});

/**
 * dec/pl 2000 lists Tract 71 as "0071" and answers "007100" with nothing, while every other vintage
 * lists "007100". A tract code the caller writes in 6 digits is sent in the 4, alone, in tract_fips,
 * or as a GEOID's tract part; the 9- and 13-digit GEOIDs dec/pl 2000 returns are read as well.
 */
describe('dec/pl 2000 lists a tract whose code ends in 00 by its first 4 digits (#97)', () => {
  const KING = scope({ state: '53', county: '033' });

  it.each([
    ['tract', '53033007100', { state: '53', county: '033' }, '007100'],
    ['tract', '530330071', { state: '53', county: '033' }, '007100'],
    ['tract', '530330004', { state: '53', county: '033' }, '000400'],
    ['tract', '53033000401', { state: '53', county: '033' }, '000401'],
    ['block', '530330071001000', { state: '53', county: '033', tract: '007100' }, '1000'],
    ['block', '5303300711000', { state: '53', county: '033', tract: '007100' }, '1000'],
    ['block group', '5303300711', { state: '53', county: '033', tract: '007100' }, '1'],
  ])(
    'reads a dec/pl 2000 %s GEOID %j as its parents and code, the tract in 6 digits',
    (level, member, parents, code) => {
      expect(splitGeoid(level, member, PL_2000)).toEqual({ parents, code });
    },
  );

  it.each([
    ['tract', '530330071', ACS, 'a 9-digit tract GEOID on another vintage'],
    ['tract', '530330071', { dataset: 'acs/acs5', year: 2009 }, 'on acs/acs5 2009'],
    ['tract', '530330071', { dataset: 'dec/pl', year: 2010 }, 'on dec/pl 2010'],
    ['block', '5303300711000', { dataset: 'dec/pl', year: 2010 }, 'a 13-digit block on 2010'],
    ['county', '053', PL_2000, 'a bare county code, whose GEOID carries no tract'],
    ['place', '63000', PL_2000, 'a bare place code, whose GEOID carries no tract'],
    ['county subdivision', '03333620', PL_2000, 'a county subdivision 2 digits short'],
    ['tract', '0071', PL_2000, 'a bare 4-digit tract'],
    ['tract', '5303300710', PL_2000, 'a tract GEOID 1 digit short'],
  ])('reads %s %j as no GEOID: %s', (level, member, vintage) => {
    expect(splitGeoid(level, member, vintage)).toBeUndefined();
  });

  it.each([
    ['tract', '007100', KING, '0071', KING],
    ['tract', '0071,007100,000401', KING, '0071,000401', KING],
    ['tract', '999900', KING, '9999', KING],
    ['tract', '53033007100', NO_SCOPE, '0071', KING],
    ['tract', '530330071', NO_SCOPE, '0071', KING],
    ['tract', '53033007100,530330071', NO_SCOPE, '0071', KING],
    ['block', '*', scope({ ...KING, tract: '007100' }), '*', scope({ ...KING, tract: '0071' })],
    ['block', '530330071001000', NO_SCOPE, '1000', scope({ ...KING, tract: '0071' })],
    ['block', '5303300711000', NO_SCOPE, '1000', scope({ ...KING, tract: '0071' })],
    [
      'block',
      '530330071001000,5303300711001',
      NO_SCOPE,
      '1000,1001',
      scope({ ...KING, tract: '0071' }),
    ],
    [
      'block',
      '5303300711000',
      scope({ ...KING, tract: '007100' }),
      '1000',
      scope({ ...KING, tract: '0071' }),
    ],
  ])(
    'sends dec/pl 2000 %s %j under %j as %j, with the scope %j',
    (level, fips, given, sent, out) => {
      const reading = readGeoids(level, fips, given, PL_2000);

      expect(reading.geographyFips).toBe(sent);
      expect(reading.scope).toEqual(out);
      expect(reading.members.some((member) => member.conflict)).toBe(false);
    },
  );

  it.each([
    ['tract', '0071', KING],
    ['tract', '000401', KING],
    ['tract', '0004', KING],
    ['tract', '0071, 000401', KING],
    ['block', '1000', scope({ ...KING, tract: '000401' })],
  ])('sends dec/pl 2000 %s %j exactly as written', (level, fips, given) => {
    const reading = readGeoids(level, fips, given, PL_2000);

    expect(reading.geographyFips).toBe(fips);
    expect(reading.scope).toEqual(given);
    expect(reading.shortened.size).toBe(0);
  });

  it.each([
    [{ dataset: 'acs/acs5', year: 2009 }],
    [{ dataset: 'dec/pl', year: 2010 }],
    [{ dataset: 'dec/pl', year: 2020 }],
    [{ dataset: 'nonemp', year: 2000 }],
  ])('sends "007100" and tract_fips "007100" as written on %j', (vintage) => {
    expect(readGeoids('tract', '007100', KING, vintage).geographyFips).toBe('007100');
    expect(readGeoids('tract', '53033007100', NO_SCOPE, vintage).geographyFips).toBe('007100');
    const block = readGeoids('block', '*', scope({ ...KING, tract: '007100' }), vintage);
    expect(block.scope.tract).toBe('007100');
    expect(block.shortened.size).toBe(0);
  });

  it.each([
    ['tract', '007100', KING, [['007100', '0071']]],
    [
      'tract',
      '0071,007100,012300',
      KING,
      [
        ['007100', '0071'],
        ['012300', '0123'],
      ],
    ],
    ['tract', '53033007100', NO_SCOPE, [['007100', '0071']]],
    ['block', '*', scope({ ...KING, tract: '007100' }), [['007100', '0071']]],
    ['block', '530330071001000', NO_SCOPE, [['007100', '0071']]],
    ['block', '530330071001000', scope({ ...KING, tract: '007100' }), [['007100', '0071']]],
  ])(
    'records the 6-digit tract codes in dec/pl 2000 %s %j under %j that went out in 4',
    (level, fips, given, pairs) => {
      expect([...readGeoids(level, fips, given, PL_2000).shortened]).toEqual(pairs);
    },
  );

  it.each([
    ['tract', '530330071', NO_SCOPE, 'a GEOID that carries the 4-digit tract already'],
    ['block', '5303300711000', NO_SCOPE, 'a block GEOID that carries the 4-digit tract'],
    ['tract', '53033007100', scope({ state: '06' }), 'a GEOID sent as written'],
  ])('records no shortened tract for dec/pl 2000 %s %j: %s', (level, fips, given) => {
    expect(readGeoids(level, fips, given, PL_2000).shortened.size).toBe(0);
  });

  it('compares a GEOID with tract_fips in 6 digits, whichever width the GEOID carries', () => {
    const tract = scope({ ...KING, tract: '007100' });

    for (const fips of ['530330071001000', '5303300711000']) {
      const [member] = readGeoids('block', fips, tract, PL_2000).members;
      expect(member).toEqual({ given: fips, sent: '1000' });
    }
  });

  it('records a contradicted tract in the 6 digits tract_fips takes', () => {
    const [shortForm] = readGeoids(
      'block',
      '5303300721000',
      scope({ ...KING, tract: '007100' }),
      PL_2000,
    ).members;
    expect(shortForm?.sent).toBe('5303300721000');
    expect(shortForm?.conflict?.parents).toEqual(['tract']);
    expect(shortForm?.conflict?.geoid.parents.tract).toBe('007200');
    expect(shortForm?.conflict?.scope).toEqual({ tract: '007100' });
  });

  it('records tract GEOIDs that disagree on the county in the forms they carry it in', () => {
    const reading = readGeoids('tract', '530330071,53061050100', NO_SCOPE, PL_2000);

    expect(reading.scope).toEqual(scope({ state: '53' }));
    expect([...reading.disagreements]).toEqual([['county', ['033', '061']]]);
    expect(reading.geographyFips).toBe('530330071,53061050100');
  });

  it.each([
    ['tract', '007100', PL_2000, '0071'],
    ['tract', '53033007100', PL_2000, '530330071'],
    ['tract', '530330071', PL_2000, '530330071'],
    ['tract', '000401', PL_2000, '000401'],
    ['tract', '53033000401', PL_2000, '53033000401'],
    ['tract', '0071', PL_2000, '0071'],
    ['block', '530330071001000', PL_2000, '5303300711000'],
    ['block', '5303300711000', PL_2000, '5303300711000'],
    ['block', '1000', PL_2000, '1000'],
    ['county', '53053', PL_2000, '53053'],
    ['county', '053', PL_2000, '053'],
    ['state', '53', PL_2000, '53'],
    ['tract', '007100', ACS, '007100'],
    ['tract', '53033007100', { dataset: 'acs/acs5', year: 2009 }, '53033007100'],
    ['block', '530330071001000', { dataset: 'dec/pl', year: 2010 }, '530330071001000'],
    ['tract', '53033007100', { dataset: 'nonemp', year: 2000 }, '53033007100'],
  ])('lists %s entry %j on %j as %j', (level, entry, vintage, listed) => {
    expect(listedForm(level, entry, vintage)).toBe(listed);
  });

  it('says which codes were read in the 4 digits dec/pl 2000 lists them in', () => {
    expect(describeShortenedTracts(PL_2000, new Map())).toBeUndefined();
    expect(describeShortenedTracts(PL_2000, new Map([['007100', '0071']]))).toBe(
      'dec/pl (2000) lists a census tract whose 6-digit code ends in 00 by its first 4 digits, the form its rows and GEOIDs carry, so "007100" was read as "0071".',
    );
    expect(
      describeShortenedTracts(
        PL_2000,
        new Map([
          ['53033007100', '530330071'],
          ['012300', '0123'],
        ]),
      ),
    ).toBe(
      'dec/pl (2000) lists a census tract whose 6-digit code ends in 00 by its first 4 digits, the form its rows and GEOIDs carry, so "53033007100" was read as "530330071" and "012300" was read as "0123".',
    );
  });
});
