/**
 * @fileoverview ACS publication coverage guidance for missing geographies in data tools.
 * @module mcp-server/tools/acs-coverage
 */

/**
 * Describe coverage as one possible cause of missing data, never a diagnosis from an empty row set.
 * Thresholds follow the Census ACS Data Release Rules; continuity and MSA exceptions can apply.
 */
export function describeAcsCoverage(dataset: string): string | undefined {
  let rule: string;
  let alternative = 'acs/acs5';
  switch (dataset) {
    case 'acs/acs1':
      rule = 'ACS one-year estimates generally cover areas with 65,000 or more people';
      break;
    case 'acs/acs1/profile':
    case 'acs/acs1/cprofile':
      rule = 'ACS one-year profiles generally cover areas with 65,000 or more people';
      alternative = 'acs/acs5/profile';
      break;
    case 'acs/acsse':
      rule = 'ACS supplemental estimates generally cover areas with 20,000 or more people';
      break;
    case 'acs/acs5/cprofile':
      rule = 'ACS five-year comparison profiles generally cover areas with 5,000 or more people';
      alternative = 'acs/acs5/profile';
      break;
    case 'acs/acs1/spp':
      rule =
        'ACS selected population profiles require an area population of 500,000 and a subgroup population of 65,000';
      break;
    case 'acs/acs1/subject':
      rule =
        'ACS one-year subject tables generally cover areas with 65,000 or more people, and selected tables have additional subgroup publication rules';
      alternative = 'acs/acs5/subject';
      break;
    default:
      return undefined;
  }
  const history = dataset.endsWith('/cprofile')
    ? ' Switching to data profiles does not preserve comparison history.'
    : '';
  return `${rule}; continuity and metropolitan-area exceptions can apply. Coverage is a possible cause of missing data, not proof that a code is wrong or an area is below a threshold. For broader geographic coverage, try dataset "${alternative}" and use census_search_variables or census_get_variable to find corresponding variables; changing datasets alone does not translate variable codes.${history}`;
}
