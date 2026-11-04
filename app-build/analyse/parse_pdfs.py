# Step 1 of analysing a village: read the SEC Rajasthan panchayat voter-list PDFs.
# From the text layer (exact for numbers, Voter IDs, labels; Hindi names only as a "skeleton" because the font map
# drops vowel signs) it writes <work>/cards.json, plus for name reading one image per card page
# (<work>/img/w<ward>_pNN.png) and <work>/img/w<ward>_manifest.json (the cards on each page, in order).
# Usage:  <python with pymupdf> app-build/analyse/parse_pdfs.py <village folder> <work folder>
import pymupdf, glob, re, json, sys, os
REL = [('नपतर', 'पिता'), ('मरतर', 'माता'), ('पनत', 'पति'), ('अनज', 'अन्य')]
SECT = {'1': 'addition', '2': 'deletion', '3': 'correction'}

def spans(page):
    out = []
    for b in page.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            for s in l['spans']:
                if s['text'].strip():
                    x0, y0, x1, y1 = s['bbox']
                    out.append(dict(t=s['text'].strip(), f=s['font'], x=x0, y=y0, x1=x1, y1=y1))
    return out

def parse(path):
    d = pymupdf.open(path)
    cover = d[0].get_text()
    nums = lambda pat, text=None: (re.search(pat, cover if text is None else text) or [None, None])[1]
    # the garbled labels differ a little between PDFs (रररर / ररडर, ककत / कनत)
    info = dict(ward=nums(r'रर[रड]र कमरपक : (\d+)') or nums(r'Ward No-0*(\d+)', os.path.basename(path)),
                zp=nums(r'नज॰ प॰ सदसज ननरररचन क[कन]त : (\d+)'),
                ps=nums(r'पप॰ स॰ सदसज ननरररचन क[कन]त : (\d+)'), booth=nums(r'\n(\d+) - [^\n]*\n'))
    # counts block after the booth line: start, end?, ..., male, female, third, total (order seen in text)
    m = re.search(r'\n\d+ - [^\n]*\n(\d+)\n(\d+)\nततलज ललग\n(\d+)\n(\d+)\n(\d+)\n(\d+)', cover)
    if m: info.update(last=int(m[1]), first=int(m[2]), male=int(m[3]), female=int(m[4]), third=int(m[5]), total=int(m[6]))
    cards, section, mohalla = [], 'main', ''
    for pi in range(1, d.page_count):
        sp = spans(d[pi])
        boxes = [s for s in sp if s['f'] == 'TimesNewRoman,Bold' and re.fullmatch(r'\d{1,4}', s['t'])]
        events = []
        for s in sp:
            if s['f'] == 'TimesNewRoman,Bold' or s['x'] > 60 or s['y'] < 140: continue
            if any(abs(s['y'] - b['y']) < 70 and -15 < s['x'] - b['x'] < 160 and s['y'] > b['y'] - 3 for b in boxes): continue
            mm = re.match(r'घटक (\d)', s['t'])
            if mm: events.append((s['y'], 'sect', SECT.get(mm[1], 'other')))
            elif s['t'].startswith('(क)'): events.append((s['y'], 'sect', 'summary'))
            elif ',' in s['t']: events.append((s['y'], 'moh', s['t']))
        for b in boxes: events.append((b['y'], 'card', b))
        for y, kind, v in sorted(events, key=lambda e: (e[0], e[2]['x'] if e[1] == 'card' else 0)):
            if kind == 'sect': section = v; continue
            if kind == 'moh': mohalla = v; continue
            if section == 'summary': continue
            bx, by = v['x'], v['y']
            cell = [s for s in sp if s is not v and -15 < s['x'] - bx < 150 and -3 < s['y'] - by < 66]
            row = lambda lo, hi, xlo=-15, xhi=95: sorted([s for s in cell if lo <= s['y'] - by < hi and xlo < s['x'] - bx < xhi], key=lambda s: s['x'])
            epic = next((s['t'] for s in row(-3, 8, 10, 120) if re.fullmatch(r'[A-Z]{2,3}\d{5,}|RJ/[\d/]+', s['t'])), '')
            name = ' '.join(s['t'] for s in row(10, 22, 5) if not s['t'].startswith('नरम'))
            relrow = row(22, 36)
            reltext = ' '.join(s['t'] for s in relrow)
            rel = next((r for k, r in REL if reltext.startswith(k)), '')
            relname = ' '.join(s['t'] for s in relrow if ':' not in s['t'])
            house = ' '.join(s['t'] for s in row(36, 50, 40) if 'मकरन' not in s['t'])
            agerow = row(50, 64, -15, 120)
            age = next((int(m2[1]) for s in agerow for m2 in [re.search(r'आजच:\s*(\d+)', s['t'])] if m2), None)
            sext = ' '.join(s['t'] for s in agerow if s['x'] - bx > 50)
            sex = 'पुरुष' if 'पचरष' in sext else 'स्त्री' if re.search(r'^सल|सब', sext) else 'तृतीय लिंग' if sext.strip() else ''
            mark = ''.join(s['t'] for s in cell if s['f'] == 'TimesNewRoman,Bold' and -12 < s['x'] - bx < 0 and abs(s['y'] - by) < 3)
            cards.append(dict(page=pi + 1, box=int(v['t']), section=section, mohalla=mohalla, epic=epic, nameSkel=name,
                              rel=rel, relSkel=relname, house=house, age=age, sex=sex, sexRaw=sext, mark=mark,
                              bx=round(bx, 1), by=round(by, 1)))
    return info, cards

def render(path, cards, ward, work):
    import collections
    d, pages = pymupdf.open(path), collections.defaultdict(list)
    for c in cards: pages[c['page']].append(c)
    man = {}
    for p, cs in sorted(pages.items()):
        top, bot = min(c['by'] for c in cs) - 8, max(c['by'] for c in cs) + 68
        d[p - 1].get_pixmap(dpi=150, clip=pymupdf.Rect(30, top, 565, bot)).save(f'{work}/img/w{ward}_p{p:02d}.png')
        man[p] = [{k: c[k] for k in ['box', 'section', 'mark', 'rel', 'sex', 'nameSkel', 'relSkel']} for c in cs]
    json.dump(man, open(f'{work}/img/w{ward}_manifest.json', 'w'), ensure_ascii=False, indent=0)

if __name__ == '__main__':
    folder, work = sys.argv[1], sys.argv[2]
    os.makedirs(os.path.join(work, 'img'), exist_ok=True); os.makedirs(os.path.join(work, 'names'), exist_ok=True)
    res = {}
    for f in sorted(glob.glob(os.path.join(folder, '*Ward No-*.pdf'))):
        if 'complete' in f: continue
        info, cards = parse(f)
        res[os.path.basename(f)] = dict(info=info, cards=cards)
        render(f, cards, int(info['ward']), work)
        sec = {k: sum(c['section'] == k for c in cards) for k in ('main', 'addition', 'deletion', 'correction')}
        print(f"{os.path.basename(f)}: ward {info['ward']} booth {info['booth']} ps {info['ps']} zp {info['zp']} · cover total {info.get('total')} · cards {sec}")
    json.dump(res, open(os.path.join(work, 'cards.json'), 'w'), ensure_ascii=False, indent=0)
