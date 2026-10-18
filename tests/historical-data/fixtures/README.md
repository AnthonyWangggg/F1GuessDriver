# Historical test fixture

`1951-france.json` is the unmodified JSON payload fetched on 2026-10-08 from:

https://api.jolpi.ca/ergast/f1/1951/4/results.json?limit=100

26 source entries include shared drives and repeated drivers. The test reads this file locally; it makes no external requests. Reviewed race-level credits are separately sourced in `data/reviews/race-results.json`. Integration tests use clearly named synthetic fixture drivers in a disposable PostgreSQL schema and never put them in the application dataset.

Source attribution: Jolpica-F1 contributors, API response retrieved 2026-10-08; this fixture preserves the response without transformation. The API data is subject to [Jolpica Terms of Use](https://github.com/jolpica/jolpica-f1/blob/main/TERMS.md) (2025-08-27), which specify [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) and non-commercial use. The API implementation's Apache-2.0 license does not replace the data terms. Public redistribution remains subject to the owner's data review in [publication-audit](../../../docs/publication-audit.md).
