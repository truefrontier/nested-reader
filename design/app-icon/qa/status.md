## Status

- Validated: `Nested.icns` contains the ten standard macOS wells; 16 px and 32 px use the thickened light SVG route, and 64 px through 1024 px use the cream-background raster route.
- Validated: `src-tauri/icons/icon.icns` and the PNG fallbacks contain the cream artwork. A fresh Tauri build embedded an identical ICNS in the app bundle and produced a DMG.
- Not tested: Finder, Dock, Spotlight, notification, physical-device, App Review, and Icon Composer contexts.

## Artifact

- Full-size source: `production/flattened/app-icon-1024.png`
- Small-size source: `concepts/light-appearance-b1/nested-logomark-tight-small-light.svg`
- Production ICNS: `production/Nested.icns`
- Prepared dark counterpart: `production/Nested-dark-prepared.icns`
- Target route: Tauri macOS bundle `src-tauri/icons/icon.icns`
- Approved full-size SHA-256: `46a501cf82d28465cc52537db965430dcb686975f2842258f1ca15e16b482be6`
- ICNS SHA-256: `a64d1dc0a220163fe54725e9c7cce2b309ba767e083eb993a2da3e9867176c02`

## Evidence

- `iconutil --convert iconset` verified all ten wells from the packaged app icon.
- Fresh app: `/tmp/nested-light-icon-build.OlKOC7/release/bundle/macos/Nested.app`
- Fresh DMG: `/tmp/nested-light-icon-build.OlKOC7/release/bundle/dmg/Nested_0.1.0_aarch64.dmg`
- The source and app-bundled `icon.icns` SHA-256 values match: `a64d1dc0a220163fe54725e9c7cce2b309ba767e083eb993a2da3e9867176c02`.
