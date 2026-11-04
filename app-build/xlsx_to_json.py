# Turns a village's analysed Excel file into the voters.json the app is built from.
#   <village>/*All Wards.xlsx  →  <village>/voters.json
# The workbook needs two sheets (the layout used for Adsar):
#   "All Wards":   Box Number | Voter ID | Name | Relative Name | Relation | House | Age | Gender | Ward | Matdan Kendra
#                  [| Deleted]   (optional: E / S / R for a voter struck off the roll; they are kept and shown tagged)
#   "Hindi Check": Ward | Box Number | नाम (हिंदी) | पिता/माता/पति का नाम (हिंदी) | ...
#
# Usage:  .venv/bin/python app-build/xlsx_to_json.py adsar
import glob
import json
import os
import sys

import openpyxl

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
village = sys.argv[1] if len(sys.argv) > 1 else sys.exit('usage: xlsx_to_json.py <village folder>')
folder = os.path.join(root, village)
files = [f for f in glob.glob(os.path.join(folder, '*All Wards.xlsx')) if not os.path.basename(f).startswith('~$')]
if len(files) != 1:
    sys.exit(f'expected exactly one "*All Wards.xlsx" in {folder}, found {len(files)}')

wb = openpyxl.load_workbook(files[0], read_only=True)
hindi = {}
for r in list(wb['Hindi Check'].iter_rows(values_only=True))[1:]:
    if r[0] is not None:
        hindi[(int(r[0]), int(r[1]))] = (r[2] or '', r[3] or '')

fields = ['ward', 'box', 'epic', 'hname', 'hrel', 'rel', 'house', 'age', 'sex', 'name', 'relname', 'del']
rows, kendra, missing = [], {}, []
for r in list(wb['All Wards'].iter_rows(values_only=True))[1:]:
    if r[0] is None:
        continue
    box, epic, name, relname, rel, house, age, sex, ward, kd = r[:10]
    gone = (r[10] if len(r) > 10 else None) or ''
    ward, box = int(ward), int(box)
    hname, hrel = hindi.get((ward, box), ('', ''))
    if not hname:
        missing.append(f'ward {ward} box {box}')
    rows.append([ward, box, epic or '', hname, hrel, rel or '', '' if house is None else str(house),
                 '' if age is None else int(age), sex or '', name or '', relname or '', str(gone).strip().upper()])
    if kd:
        kendra.setdefault(str(ward), kd)

rows.sort(key=lambda x: (x[0], x[1]))
out = os.path.join(folder, 'voters.json')
with open(out, 'w', encoding='utf-8') as f:
    json.dump({'kendra': kendra, 'fields': fields, 'rows': rows}, f, ensure_ascii=False, separators=(',', ':'))
wards = sorted({r[0] for r in rows})
gone = sum(1 for r in rows if r[-1])
print(f'{out}: {len(rows) - gone} voters (+{gone} struck off) in wards {wards[0]}–{wards[-1]}' if rows else f'{out}: no voters')
if missing:
    print(f'warning: no Hindi name for {len(missing)} voters, e.g. {", ".join(missing[:5])}')
