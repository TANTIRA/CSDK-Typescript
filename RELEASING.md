# Releasing @convergehq/sdk

There are two ways to publish to npm:

- **Path A, manual:** from a maintainer's machine, signed in to npm with 2FA. The first release takes this path.
- **Path B, automated:** through `.github/workflows/release.yml` and npm trusted publishing (OIDC, no stored token, with provenance), once GitHub Actions can run for this repository.

Only the owner of the npm organization `convergehq` does these steps. Nobody else creates accounts, tokens or publishers for you.

## Before every release

1. Set `version` in `package.json` and `VERSION` in `src/index.ts`.
2. Move the entries in `changelog/@unreleased/` into `changelog/<version>/`.
3. Run the tests and check the package contents:

   ```sh
   npm ci
   npm test
   npm pack --dry-run
   ```

   The tarball must contain only `dist/`, `README.md`, `LICENSE`, `NOTICE` and `package.json`.
4. Merge through a pull request, then tag the merge commit: `git tag v0.1.0 && git push origin v0.1.0`.

## Path A: manual (first release)

1. Sign in at npmjs.com with an owner of the `convergehq` organization, and turn on 2FA for publishing.
2. From a clean checkout of the tag:

   ```sh
   npm ci && npm test
   npm login
   npm publish --access public
   ```

   npm asks for the 2FA one-time password. A manual publish has no provenance statement; path B adds one.

## Path B: trusted publishing (once Actions can run)

1. On npmjs.com, under the package `@convergehq/sdk` → *Settings* → *Trusted publishing*, add GitHub Actions:
   - Organization or user: `TANTIRA`, repository: `CSDK-Typescript`
   - Workflow: `release.yml`
   - Environment: `npm`
2. In this repository, create the environment `npm` (*Settings → Environments*). Optionally require a reviewer.
3. Set the repository variable `NPM_TRUSTED_PUBLISHING` to `true` (*Settings → Secrets and variables → Actions → Variables*).

From then on, pushing a `v*` tag tests, packs and publishes with provenance. Until the variable is set, the publish job is skipped rather than failed, and the build job still runs and keeps the tarball as an artifact. The workflow also refuses a tag that does not match the package version.
