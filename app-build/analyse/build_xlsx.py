# Step 3 of analysing a village: combine <work>/cards.json and the names (<work>/names/w*.json) into the village's
# Excel files (Adsar layout), and check every ward against its cover page totals.
#   final roll per ward = main list − boxes in the deletion supplement, with corrections applied, + additions
# The deleted main-list voters stay in the files, in box order, with their mark in the last column (E death, S shifted,
# R repeated); the app shows them tagged as struck off. The cover check counts only the voters on the roll.
# <work>/booths.json maps booth number → Matdan Kendra text read from the cover page, e.g.
#   {"72": "72-राजकीय उच्च माध्यमिक विद्यालय डालमाण (बांया भाग)"}
# Usage:  .venv/bin/python app-build/analyse/build_xlsx.py <village folder> <work folder> <FILE PREFIX, e.g. DALMAN>
import json, sys, os, collections
import openpyxl
from openpyxl.styles import Font, PatternFill

folder, T, PREFIX = sys.argv[1], sys.argv[2], sys.argv[3]
BOOTH = json.load(open(os.path.join(T, 'booths.json')))
cards = json.load(open(os.path.join(T, 'cards.json')))

HEAD_FONT, HEAD_FILL = Font(bold=True, color='FFFFFFFF'), PatternFill('solid', fgColor='FF2F5597')
VCOLS = ['Box Number', 'Voter ID', 'Name', 'Relative Name', 'Relation', 'House', 'Age', 'Gender', 'Ward', 'Matdan Kendra', 'Deleted']
VW = [12, 19, 24, 24, 10, 9, 7, 9, 7, 42, 9]
HCOLS = ['Ward', 'Box Number', 'नाम (हिंदी)', 'पिता/माता/पति का नाम (हिंदी)', 'Name', 'Relative Name', 'PDF Page']
HW = [7, 12, 22, 26, 24, 24, 10]

def sheet(ws, cols, widths, rows):
    ws.append(cols)
    for c in ws[1]: c.font, c.fill = HEAD_FONT, HEAD_FILL
    for r in rows: ws.append(r)
    for i, w in enumerate(widths): ws.column_dimensions[openpyxl.utils.get_column_letter(i + 1)].width = w
    ws.freeze_panes = 'A2'
    ws.auto_filter.ref = ws.dimensions

allv, allh, report = [], [], []
for f, v in sorted(cards.items(), key=lambda kv: int(kv[1]['info']['ward'])):
    info, cs = v['info'], v['cards']
    w = int(info['ward'])
    names = {(n['section'], n['box']): n for n in json.load(open(os.path.join(T, 'names', f'w{w}.json')))}
    kendra = BOOTH[info['booth']]
    main = {c['box']: c for c in cs if c['section'] == 'main'}
    fixed = {c['box']: c for c in cs if c['section'] == 'correction'}   # a correction can replace a main card or an addition
    added = [fixed.get(c['box'], c) for c in cs if c['section'] == 'addition']
    main.update((b, c) for b, c in fixed.items() if b in main)
    deleted = {c['box']: c['mark'] or 'S' for c in cs if c['section'] == 'deletion'}   # box → E / S / R
    # box numbers run on through the additions, so a voter added and then struck off is in the deletion supplement too
    final = [c for b, c in sorted(main.items()) if b not in deleted] + [c for c in added if c['box'] not in deleted]
    listed = sorted(main.values(), key=lambda c: c['box']) + added   # with the deleted
    vrows, hrows = [], []
    for c in listed:
        n = names[(c['section'], c['box'])]
        gone = deleted.get(c['box']) if c['section'] in ('main', 'correction', 'addition') else None
        vrows.append([c['box'], c['epic'] or None, n['name'], n['relname'], c['rel'], c['house'], c['age'], c['sex'], w, kendra, gone])
        hrows.append([w, c['box'], n['hname'], n['hrel'], n['name'], n['relname'], c['page']])
    wb = openpyxl.Workbook()
    sheet(wb.active, VCOLS, VW, vrows); wb.active.title = 'Voter List'
    sheet(wb.create_sheet('Hindi Check'), HCOLS, HW, hrows)
    wb.save(os.path.join(folder, f'{PREFIX}-Ward No-{w:03d}.xlsx'))
    allv += vrows; allh += hrows
    sx = collections.Counter(c['sex'] for c in final)
    ok = (sx['पुरुष'], sx['स्त्री'], len(final)) == (info['male'], info['female'], info['total'])
    report.append(f"ward {w}: {len(final)} voters ({sx['पुरुष']} M, {sx['स्त्री']} F) cover {info['total']} ({info['male']} M, {info['female']} F) "
                  f"{'OK' if ok else 'MISMATCH'} · booth {kendra} · +{sum(c in added for c in final)} added, "
                  f"-{len(deleted)} deleted (kept, tagged), corrected {[c['box'] for c in cs if c['section'] == 'correction']}")

wb = openpyxl.Workbook()
sheet(wb.active, VCOLS, VW, allv); wb.active.title = 'All Wards'
sheet(wb.create_sheet('Hindi Check'), HCOLS, HW, allh)
wb.save(os.path.join(folder, f'{PREFIX}-All Wards.xlsx'))
gone = sum(1 for r in allv if r[-1])
print('\n'.join(report)); print(f'total {len(allv) - gone} voters on the roll, +{gone} struck off (kept, tagged)')
