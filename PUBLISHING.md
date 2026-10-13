# Publishing

The `Publish` GitHub workflow packages the extension and publishes it to the VS Code Marketplace when a
version tag is pushed. The package holds only what `files` in package.json lists: `src/**/*.js`, the
icon, the README, the changelog and the license. Check it with `npm run package:list`.

## Releasing a version

1. Raise `version` in package.json and add its entry to CHANGELOG.md.
2. Run `npm run test:live`, then commit.
3. Tag and push: `git tag v0.1.1 && git push origin main v0.1.1`.

The workflow checks that the tag matches `version`, packages, publishes, and attaches the `.vsix` to a
GitHub release. Run it by hand with mode `package` to only build the `.vsix` (download it from the run's
artifacts), or with mode `publish` to publish the current branch's version.
