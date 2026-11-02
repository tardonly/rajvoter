# Step 3 of analysing a village: combine <work>/cards.json and the names (<work>/names/w*.json) into the village's
# Excel files (Adsar layout), and check every ward against its cover page totals.
#   final roll per ward = main list − boxes in the deletion supplement, with corrections applied, + additions
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
VCOLS = ['Box Number', 'Voter ID', 'Name', 'Relative Name', 'Relation', 'House', 'Age', 'Gender', 'Ward', 'Matdan Kendra']
VW = [12, 19, 24, 24, 10, 9, 7, 9, 7, 42]
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
    for c in cs:
        if c['section'] == 'correction': main[c['box']] = c
    deleted = {c['box'] for c in cs if c['section'] == 'deletion'}
    final = [c for b, c in sorted(main.items()) if b not in deleted] + [c for c in cs if c['section'] == 'addition']
    vrows, hrows = [], []
    for c in final:
        n = names[(c['section'], c['box'])]
        vrows.append([c['box'], c['epic'] or None, n['name'], n['relname'], c['rel'], c['house'], c['age'], c['sex'], w, kendra])
        hrows.append([w, c['box'], n['hname'], n['hrel'], n['name'], n['relname'], c['page']])
    wb = openpyxl.Workbook()
    sheet(wb.active, VCOLS, VW, vrows); wb.active.title = 'Voter List'
    sheet(wb.create_sheet('Hindi Check'), HCOLS, HW, hrows)
    wb.save(os.path.join(folder, f'{PREFIX}-Ward No-{w:03d}.xlsx'))
    allv += vrows; allh += hrows
    sx = collections.Counter(c['sex'] for c in final)
    ok = (sx['पुरुष'], sx['स्त्री'], len(final)) == (info['male'], info['female'], info['total'])
    report.append(f"ward {w}: {len(final)} voters ({sx['पुरुष']} M, {sx['स्त्री']} F) cover {info['total']} ({info['male']} M, {info['female']} F) "
                  f"{'OK' if ok else 'MISMATCH'} · booth {kendra} · +{sum(c['section'] == 'addition' for c in final)} added, "
                  f"-{len(deleted)} deleted {sorted(deleted)}, corrected {[c['box'] for c in cs if c['section'] == 'correction']}")

wb = openpyxl.Workbook()
sheet(wb.active, VCOLS, VW, allv); wb.active.title = 'All Wards'
sheet(wb.create_sheet('Hindi Check'), HCOLS, HW, allh)
wb.save(os.path.join(folder, f'{PREFIX}-All Wards.xlsx'))
print('\n'.join(report)); print(f'total {len(allv)} voters')
