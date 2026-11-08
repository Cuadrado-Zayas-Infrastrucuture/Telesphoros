# A release that loses guideline coverage is listed before anyone signs it

Date: 2026-11-08

`knowledge:diff OLD NEW` lists, for each guideline, the phenotype combinations NEW added or removed compared with OLD, and exits 1 when coverage was lost. A guideline that disappears loses every combination it covered.

`knowledge:verify --production` now refuses an empty knowledge set unless `--allow-empty` is given, and under the production rules the pipeline refuses to start with one. CI passes `--allow-empty` while `knowledge/cpic` holds no guideline; the flag comes out when the first reviewed guideline lands.

Not done: the diff has only compared test knowledge sets, since no reviewed guideline exists yet.
