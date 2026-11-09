# Licenses for packages that ship none

Some packages the app ships have no license file in the package. `scripts/third-party-notices.mjs` takes their text from here instead, one `<name>@<version>` folder each, and stops if a package has neither.

Each folder holds the license files (named like `LICENSE*`, `COPYRIGHT*` or `NOTICE*`) and a `SOURCE` file. `SOURCE` starts with the link the text came from and says how it was made. There are three kinds:

- **Fetched.** The license files in the repository, at the commit the crate was published from. `node scripts/fetch-upstream-licenses.mjs <name>@<version>` writes these.
- **Copied.** Where the license is only in the README, its License section, word for word (`fastdom`).
- **Filled in.** Where upstream has no license text or no copyright line, the license the manifest declares, from GitHub's copy, with a copyright line naming the manifest's authors. `SOURCE` says so.

When a package here changes version, the notices check fails until its folder is fetched or written again for the new version.

The fetch script copies only what upstream has. For objc2's crates that is `LICENSE.md`, which names the license but holds no license text or copyright line, so after fetching a new version, copy the `LICENSE-MIT` over from the old folder too. The check can't tell that it is missing.
