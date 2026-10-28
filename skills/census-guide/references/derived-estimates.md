# Margins of error for derived ACS estimates

Formulas from the Census Bureau's *Understanding and Using American Community Survey Data: What All Data Users Need to Know* (2020), chapters 7 and 8: <https://www.census.gov/content/dam/Census/library/publications/2020/acs/acs_general_handbook_2020.pdf>. All margins are at the 90 percent level the ACS publishes.

## Standard error

SE = MOE / 1.645

## Significance of a difference

The difference between estimates X1 and X2 is statistically significant at 90 percent when

|X1 − X2| / √(SE1² + SE2²) > 1.645

which is the same as |X1 − X2| > √(MOE1² + MOE2²). Use 1.960 for 95 percent or 2.576 for 99 percent. Overlapping confidence intervals are not a substitute for this test.

## Sum or difference of estimates

MOE(X1 + X2 + … + Xn) = √(MOE1² + MOE2² + … + MOEn²)

The same formula covers a sum across geographies (a three-county region) and across lines of one table (income brackets).

## Proportion

For a proportion P = X / Y where X is a subset of Y (renters paying 30 percent or more, out of all renters with a computed ratio):

MOE(P) = (1 / Y) · √(MOE(X)² − P² · MOE(Y)²)

If the value under the square root is negative, use a plus sign instead, which is the ratio formula below. Multiply P and its MOE by 100 for a percentage.

## Ratio

For a ratio R = X / Y where X is not a subset of Y:

MOE(R) = (1 / Y) · √(MOE(X)² + R² · MOE(Y)²)

## Percent change

Percent change from an earlier estimate X1 to a later X2 is 100 · (X2 / X1 − 1). Its MOE is 100 times the ratio MOE of X2 / X1. The formula ignores the correlation between overlapping periods, so use it on non-overlapping periods.

## Caveats

- Each formula is an approximation that ignores the covariance between the component estimates. It can overstate or understate the true margin, and the error grows with the number of estimates combined. Use as few components as possible.
- A published collapsed table or published percentage has a more accurate margin than one derived here. Check the profile (DP) and subject (S) tables before deriving.
