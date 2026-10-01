# locus-runtime

Browser-local Unix-like execution substrate for Locus: Linux-like VFS, shell,
Python (verified Pyodide bootstrap), isolated grep workers, and bounded
anonymous network transport.

This repository is being extracted from
[boccchi2993/Locus-browser-agent-runtime](https://github.com/boccchi2993/Locus-browser-agent-runtime)
(three-repository split, milestone M3a). The implementation lands on the
`refactor/extract-runtime` branch and is up for review as an extraction PR
against this `main` branch — the packages, tests, build, and documentation
described in the split design are NOT on `main` yet.

Provenance of everything that will land here: [docs/PROVENANCE.md](docs/PROVENANCE.md).

## Status

- **Extraction candidate** — not yet the authoritative Runtime. The product
  repository keeps working unchanged until its imports switch (M3c).
- The extraction PR must not be treated as merged until its review completes.

## License

Apache-2.0. See [LICENSE](LICENSE).
