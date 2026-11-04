# Brief: read one ward's voter names from page images

You are given a village folder `<v>` and a ward number `<w>`. Work in /Users/janak/Downloads/rajvoterlists.
Read CLAUDE.md there first (section "Analyse <village>", especially "What a ward PDF contains" and "Tools" step 2).

Inputs
- `<v>/analysis/img/w<w>_manifest.json`: page → cards in order {box, section (main/addition/deletion/correction),
  mark, rel, sex, nameSkel, relSkel}. nameSkel/relSkel are the PDF text layer's letters (vowel signs mostly missing:
  ू often as ब or ड, े as क or न, ी as ल, ड as र), useful to check a reading.
- `<v>/analysis/img/w<w>_pNN.png`: one image per card page. Read every image with the Read tool; cards are 3 per
  row, each with box number, name and father/husband/mother name.

Output: `<v>/analysis/names/w<w>.json`. If it already exists, check it against the images instead of retyping.
Write it EARLY and update it after every 3–4 pages, so progress survives an interruption. A JSON array, one entry
per card for every main card (including those marked deleted; skip a main card marked `#`), every addition and
every correction. Skip 'deletion' section cards (they repeat main cards). Format exactly:

    {"page": 3, "box": 1, "section": "main", "hname": "<name in Devanagari as printed>",
     "hrel": "<relative's name in Devanagari as printed>", "name": "<Roman spelling>", "relname": "<Roman spelling>"}

Roman spelling style: "प्रभु सिंह" → "Prabhu Singh", "दुर्गादेवी" → "Durgadevi", "मांगी लाल" → "Mangi Lal" (keep the
word split as printed). See dalman/analysis/names/w1.json for examples. Copy Hindi names exactly as printed, odd
spellings included. If a card prints broken glyphs (dotted circles, boxes), pick the nearest reading and note it.

Then run `node app-build/analyse/check_names.js <v>/analysis <w>`. Re-look at every CHECK/MISSING/EMPTY line on the
image and fix the file (a CHECK may stay if the image really shows your reading). Re-run until only genuinely
correct CHECK lines remain.

Write no other project file (scratch files go in $TMPDIR). Report briefly: entry count, the final check_names
summary line, CHECK lines kept (box + why) and any broken-glyph or doubtful cards.
