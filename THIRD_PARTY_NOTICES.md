# Third-Party Notices

The following runtime libraries are bundled so conversion and rehearsal playback
do not need a CDN. They retain their own licenses. Their existing license files
and attribution comments must remain with redistributed copies. The builder
embeds notices in each standalone HTML output.

| Component | Local files | License and upstream source |
| --- | --- | --- |
| AlphaTab 1.8.4, build 34 | `vendor/alphatab/alphaTab.min.js` | [MPL 2.0](vendor/alphatab/LICENSE); [corresponding source](https://github.com/CoderLine/alphaTab/tree/022a45c8e42370f9e12e68949d11eada370da83d) |
| Bravura music font | `vendor/alphatab/font/Bravura.woff2` | [SIL Open Font License 1.1](vendor/alphatab/font/Bravura-OFL.txt); [source](https://github.com/steinbergmedia/bravura) |
| Pitchy | `vendor/pitchy/index.js` | [MIT](vendor/pitchy/LICENSE); [source](https://github.com/ianprime0509/pitchy) |
| fft.js | `vendor/fft/fft.js` | [MIT](vendor/fft/LICENSE); [source](https://github.com/indutny/fft.js) |
| Lucide icons | Inline icon paths in `template/index.html` | [ISC](vendor/lucide/LICENSE); [source](https://github.com/lucide-icons/lucide) |
| YouTube brand icon | Inline path in `template/index.html` | [Simple Icons source](https://github.com/simple-icons/simple-icons/blob/develop/icons/youtube.svg), [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

AlphaTab's bundled header also credits TinySoundFont, SFZero, the Haxe standard
library, SharpZipLib, NVorbis, and libvorbis. That header is retained verbatim.
The AlphaTab source version above is the commit recorded by the bundled runtime's
`meta.commit`, not a floating link to the latest release. Melete's rendering
adjustments are in `template/`; do not replace the vendored renderer without
running the regression gate.

The font's reserved name is Bravura. Icon and library licenses do not grant
trademark rights or imply endorsement. YouTube is a trademark of Google LLC.

Playwright is a development-only dependency, pinned in `package-lock.json`
under Apache 2.0. It is not included in generated HTML. Python, Node.js and
MuseScore are external prerequisites, not redistributed by this repository.

## Runtime File Fingerprints

SHA-256 hashes of the initial shared release:

```text
2d0335501b875453d52359de23cd9cebfcf71aed3d5739f1cf95117acfd52bec  vendor/alphatab/alphaTab.min.js
181e0e7c4889f9ad57dde0a11988fa61b941617aa499ecdb9dfd4713896c2b19  vendor/alphatab/font/Bravura.woff2
79b92333cde9ec16798757f73b624abd13522da31e8fab2993c19d319b3bb36e  vendor/pitchy/index.js
4092b92cec888377666265b724d676628d377d4d5f56b03b76d9c2c27fd061ea  vendor/fft/fft.js
```

No choir repertoire, recordings, private scores or arrangement exports are
distributed here. The small MusicXML fixtures are synthetic software tests.
