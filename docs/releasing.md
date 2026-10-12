# Releasing

Each version step below is one command, run from the root, on a clean `main` that CI has passed.

Pushing a `v*` tag runs [`.github/workflows/publish.yml`](../.github/workflows/publish.yml). The publish job checks out that tag, installs from the lockfile, builds `dist/`, runs the release checks, and runs `npm publish`. npm authenticates with the GitHub Actions OIDC token for the GitHub Environment `publish`. Provenance is attached because the repository and the package are public. The environment is the human gate: the job waits until it is approved. The workflow stores no `NPM_TOKEN`, and the repository secrets do not keep one.

After `npm publish` succeeds, a second job creates the GitHub release for that tag. The publish job keeps `contents: read` and holds the npm OIDC token (`id-token: write`). The release job asks for `contents: write` only. The two permissions stay on separate jobs.

`dist/` is gitignored. The workflow builds it, then `prepack` builds it again, and that tree is what is published. `npm run build` removes `dist/` before it compiles, so a source file that was deleted does not leave its old output in the tarball. `npm pack --dry-run` names the tarball's contents: `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `package.json`. `test/pack.test.ts`, part of `npm test`, packs the package, installs the tarball into a temporary project, and runs the installed `firstlight` bin.

An environment and a trusted publisher create no state in this repository; they exist only in GitHub's and npm's own settings. Create them once, using the values below, before the first release.

## Bootstrap: not done yet

npm lets a trusted publisher be added only to a package that already exists. The name `firstlight` is not on npm yet, so the first release needs these steps, in this order. Each one is the owner's to run.

1. Publish a placeholder `0.0.1` from a local `npm login` session. The placeholder holds the package name and no code: a directory with only `package.json` (name `firstlight`, version `0.0.1`, the `repository` field of this repository's `package.json`, and no `bin`, `scripts`, or `files`), `README.md` (one paragraph that says the version holds no code and names the first usable version), and `LICENSE`. Run `npm pack --dry-run` there first and read the file list: those three files and nothing else. Do not create an access token for it.
2. Add the GitHub Actions trusted publisher on npmjs.com, with the values under "Trusted publisher" below.
3. Create the GitHub Environment `publish` with required reviewers.
4. Release the first usable version through "Each version" below. It is the first publish through OIDC, with provenance. Then, in the package settings on npmjs.com, require two-factor authentication and disallow token publishing. The trusted publisher keeps working. The placeholder `0.0.1` stays as it is; its own README says it holds no code.
5. Update this section to say the bootstrap is done, with the dates.

After the bootstrap, every `v*` tag publishes through OIDC alone. A manual publish is needed again only if the package is deleted from npm.

## Trusted publisher

The fields are case-sensitive:

- Organization or user: `meganemura`
- Repository: `firstlight`
- Workflow filename: `publish.yml` (the filename, including `.yml`)
- Environment name: `publish`
- Allowed action: `npm publish`

A trusted publisher created after 3 September 2026 starts with `npm stage publish` allowed. Select `npm publish` as well: the workflow runs `npm publish`.

`package.json` `repository.url` is `git+https://github.com/meganemura/firstlight.git`. npm checks that URL against the workflow repository.

The GitHub Environment `publish` needs required reviewers, so a tag push waits for a human approval before the job runs `npm publish`.

An approval appears only after a `v*` tag starts `publish.yml` and the job waits on the Environment `publish`. Registering the trusted publisher does not queue an approval.

## Action SHA pins

`publish.yml` and `ci.yml` pin each `uses:` to a full 40-character commit SHA, with the version in a comment on the same line:

- `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
- `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0`

The release job uses that same `actions/checkout` SHA. It does not run `actions/setup-node`. Creating the release does not install the package.

Turn on the repository's `sha_pinning_required` setting, so a workflow that names an action by a tag or a branch does not run.

## Each version

1. Choose the version by SemVer (before 1.0, a minor version may change the behavior). Set it in `package.json`, then turn `CHANGELOG.md`'s `## Unreleased` heading into `## <version> (<date>)`. Keep one space after the version. The release job matches the heading `## <version> `. Add a `## Unreleased` heading first if none exists.
2. `npm install --package-lock-only` so the lock file carries the version.
3. `npm run build`, `npm test`, `npm run typecheck`, and `npm run archstrict`.
4. `npm pack --dry-run` and read the file list: `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE`, `package.json`, and nothing else.
5. Commit as `release: <version>`, tag `v<version>`, push the commit and the tag. The tag without the leading `v` is the `package.json` version; the workflow stops when they differ. The tag push starts the workflow.
6. Approve the `publish` environment on that Actions run. The approval is requested when the job waits on that environment, which happens only after the tag starts `publish.yml`. The workflow uses Node 24 on `ubuntu-latest` with the npm registry URL set. It requires Node 24.20 or later on that line and npm 11.5.1 or later. It runs `npm ci`, `npm run build`, a check that the build did not modify tracked files, `npm run typecheck`, `npm test`, and `npm run archstrict`, then `npm publish`. `dist/` is gitignored, so the new build output is expected and is what gets packed.
7. After `npm publish` succeeds, the workflow's `release` job creates the GitHub release. It checks out the tag, extracts only that version's section from `CHANGELOG.md`, and runs `gh release create` with `--notes-file` and `--verify-tag`. A notes file that is the whole changelog would carry every version, so the job keeps the section whose heading is `## <version> ` (a space after the version). A release that already exists stays as it is, so a re-run of the same tag is safe. If that job fails, extract the section and create the release by hand. Set `version` to the version you tagged:

   ```sh
   version=0.1.0
   awk -v v="$version" '$0 ~ "^## " v " " {in_version=1; next} /^## /{in_version=0} in_version' CHANGELOG.md > notes.md
   gh release create "v$version" --title "v$version" --notes-file notes.md --verify-tag
   ```

Publishing to npm, pushing a release tag, approving the `publish` environment, and a change of the repository's visibility are the owner's to run.
Private vulnerability reporting stays on in the repository's Security settings; `SECURITY.md` points there, and the setting exists only for a public repository.
