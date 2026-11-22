-- Remembered package sets for the WebAssembly engine (docs/compile-engines.md): the TeX packages
-- a project's last successful server compile installed, per engine version (`texlive`, the
-- compile runtime's `wasm-<digest>`). The worker installs them before the first pass of the
-- project's next job, as the browser does with the set it keeps per project on the device. One
-- row per project and engine version; a successful compile replaces the row and drops those of
-- other versions. Package names only (catalog names, at most 64). Append-only: never edit an
-- applied file.
CREATE TABLE compile_packages (
    project text NOT NULL REFERENCES sr_projects (project) ON DELETE CASCADE,
    texlive text NOT NULL,
    packages text[] NOT NULL CHECK (cardinality(packages) <= 64),
    updated timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project, texlive)
);
