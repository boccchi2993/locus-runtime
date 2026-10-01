# Provenance — where this code comes from

Status: this repository is the **Runtime extraction candidate** of the Locus
three-repository split (M3a). It is NOT yet the authoritative Runtime; the
product repository remains authoritative until the extraction is accepted and
the product's imports switch (M3c).

## Source baseline

Everything in this repository is extracted from a single, pinned commit of the
product repository:

- Repository: https://github.com/boccchi2993/Locus-browser-agent-runtime
- Branch: `refactor/repository-split-m2c` (head of OPEN PR #7, base
  `refactor/repository-split-m2b`)
- Commit: `2aec76e78431382873be1db8a6db6310cc89c782`

No product-repository branch was rewritten, merged, or force-updated to create
this repository. The commit above is an accepted migration candidate baseline
(M2c verified); it is not `main` of the product repository, and nothing here
claims it is.

## Import method

**Snapshot import.** Files were copied from the pinned commit and then
converted (classic-script globals → ES modules; the declared
`__LOCUS_RUNTIME_CORE__` assembly seam removed). Git history is NOT filtered
or rewritten from the product repository: the new commits here are the
extraction work, authored as such. The per-file source mapping — source path,
source blob, destination path, transformation, and what was deliberately NOT
migrated — is recorded in [EXTRACTION-PLAN.md](EXTRACTION-PLAN.md) (per-file
table; the source-blob column carries the REAL `git rev-parse
<baseline>:<path>` values under the pinned commit, so every row is
independently verifiable — target-file hashes are never substituted — and
files created in this repository say so explicitly) and
[M3A-VERIFICATION.md](M3A-VERIFICATION.md) (gate evidence).

## License

- License: Apache-2.0, copied verbatim from the source repository's `LICENSE`
  (which carries the standard Apache template text with an unfilled
  `[yyyy] [name of copyright owner]` line — that placeholder is preserved as
  found; no copyright attribution has been invented).
- No `NOTICE` file exists in the source repository; none is created here.
- Source files carry no per-file copyright headers; none were added.

## Third-party material

- **Pyodide 0.26.4** — not vendored. The Python bootstrap downloads pinned,
  SHA-256-verified assets from the jsDelivr CDN at runtime
  (`PYODIDE_BASE` in `src/shell.js`). Pyodide itself is not part of this
  package.
- `tests/fixtures/pyodide-lock-snapshot.json` — an excerpt of the Pyodide
  0.26.4 lock file, used as an integrity test fixture (dependency-closure
  check). It is test data, not shipped runtime code.
- `tests/fixtures/relay/fetch.js` — a copy of the product repository's
  `functions/fetch.js` edge relay (the reference implementation of the
  `/fetch` contract the Runtime's relay routing is tested against), used ONLY
  as a self-contained test server for the network browser gate. It is not
  part of the published package and not a second authority; see
  [EXTRACTION-PLAN.md](EXTRACTION-PLAN.md) for the removal note.

## Dual-implementation period (temporary, by design)

Until M3c lands, the product repository still carries its own in-repo copy of
the Runtime implementation and keeps working unchanged. During that window:

- This repository is the **extraction candidate** only — not the authority.
- No parallel feature development happens on both copies.
- A defect found in one copy is recorded with its diff and back-port
  requirement, never silently fixed on one side only.
- At M3c the product switches to consuming this repository, and the in-repo
  copy is deleted or reduced to a one-way delegation. This window is not a
  long-term dual-maintenance arrangement.
