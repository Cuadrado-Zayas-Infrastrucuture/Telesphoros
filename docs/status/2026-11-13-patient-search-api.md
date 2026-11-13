# Patient search on the server, the API (spec 040, slice A)

Date: 2026-11-13

`GET /patients` takes an optional `labelContains`: 1 to 40 letters, digits and hyphens, matched anywhere in a patient's label, ignoring
case and literally. The answer is the same paginated list, with `meta.total` counting the matches only; `includeMerged`, `order` and paging
behave as on the unfiltered list, so a merged-away patient is found only with `includeMerged=true`. Any other text is 400 naming the field
and never repeating the value, and an API without the parameter already refuses it as unknown, so an older API cannot answer a search with
an unfiltered page. On PostgreSQL the text is a bound parameter in one fixed fragment (`strpos`, not `LIKE`), added to the page, its total
and the past-the-end count; without a search the statement is the same text as before. No migration, index, route or screen changes; the
roster and the upload pickers use it in slices B and C. Names, dates of birth and identifiers are not searchable.
