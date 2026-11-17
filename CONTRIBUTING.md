# Contributing to Scribyra

Thank you for helping. Scribyra is a small project in public beta, so clear reports
and small, focused changes help the most.

## Reporting a problem

[Open an issue](https://github.com/Scribyra/scribyra/issues/new/choose) and pick
**Bug report** or **Feature request**. For a bug, please include:

- your browser and its version, and your operating system;
- the steps that lead to the problem, and what you expected instead;
- if you can, a **diagnostics export**: in the app, open **Diagnostics** (projects
  sidebar, or **More tools → Diagnostics** in a project), turn on the local timeline,
  reproduce the problem and export the JSON. The export is designed to leave out document contents;
  check it before attaching. See [what it contains](docs/telemetry.md).

Never attach a private project unless you are happy for it to be public. A minimal
example that shows the problem is best. Security problems go to
[contact@scribyra.com](mailto:contact@scribyra.com) instead; see [SECURITY.md](SECURITY.md).

## Changing the code

1. Fork the repository, or create a branch if you have write access, from `dev`:
   `git switch -c feature/<short-name> origin/dev`.
2. Keep the change to one topic. Build and test it as described in
   [docs/development.md](docs/development.md); at least `npm test` should pass.
3. Open a pull request into **`dev`**. Its title becomes the changelog line, so say
   what changes for people using Scribyra. In the description, say why and how you
   tested it.
4. The required check **`suite / test`** (build, Rust, JavaScript and the browser
   suite) must pass, and review threads must be resolved. A maintainer then merges.

Changes reach staging at `dev.scribyra.com` when merged into `dev`, and production
when `dev` is released into `main`. Urgent production fixes use `hotfix/*` branches
into `main`. The full flow is in [docs/delivery.md](docs/delivery.md).

## Sign-off and license

By contributing, you agree that your contribution is licensed under the project's
license, [AGPL-3.0-only](LICENSE). A [DCO](https://developercertificate.org/)-style
`Signed-off-by:` line (`git commit -s`) is welcome but optional.
