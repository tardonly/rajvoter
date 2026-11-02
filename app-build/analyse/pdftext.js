// Reads the voter cards from the SEC PDF's own text layer (with pdf.js), without Gemini.
// The text layer is exact for digits and Latin text (box, Voter ID, house, age) and for the fixed labels
// (relation, gender), but its Hindi font map loses most vowel signs, so names come out as a "skeleton"
// (मागी लाल → मरगल लरल). Names are therefore read by Gemini and checked against these skeletons.
(function (root) {
  'use strict';
  const DEV = /[ऀ-ॿ]/;
  const REL = [['नपतर', 'पिता'], ['मरतर', 'माता'], ['पनत', 'पति'], ['अनज', 'अन्य']];
  const SECTION = { 1: 'addition', 2: 'deletion', 3: 'correction' };

  // Card geometry relative to the box number (pdf.js page coordinates, y grows upwards)
  const inCell = (it, s) => it.x >= s.x - 18 && it.x <= s.x + 150 && it.y >= s.y - 62 && it.y <= s.y + 4;
  const row = (items, s, lo, hi) => items.filter((it) => s.y - it.y > lo && s.y - it.y < hi).sort((a, b) => a.x - b.x);
  const text = (items) => items.map((it) => it.str).join('');
  const afterColon = (t) => t.slice(t.indexOf(':') + 1).trim();

  function pageCards(items, pageNo) {
    const devFonts = new Set(items.filter((it) => DEV.test(it.str)).map((it) => it.font));
    const latinFonts = new Set(items.filter((it) => !DEV.test(it.str) && /:/.test(it.str)).map((it) => it.font));
    // a box number has the "नाम :" label just below it on the left
    const serials = items.filter((it) => /^\d{1,3}$/.test(it.str) && +it.str > 0 && !devFonts.has(it.font) && !latinFonts.has(it.font)
      && items.some((o) => DEV.test(o.str) && it.y - o.y > 10 && it.y - o.y < 22 && o.x >= it.x - 18 && o.x <= it.x + 2));
    const cards = serials.map((s) => {
      const cell = items.filter((it) => it !== s && inCell(it, s));
      const left = cell.filter((it) => it.x < s.x + 94);   // the photo box starts at about +96
      const epic = (cell.find((it) => /^([A-Z]{2,3}\d{5,}|RJ\/[\d/]+)$/.test(it.str.trim())) || { str: '' }).str.trim();
      const marker = (cell.find((it) => it.font === s.font && /^[A-Z#]$/.test(it.str.trim()) && it.x < s.x) || { str: '' }).str.trim();
      const nameRow = text(row(left, s, 10, 22)), relRow = text(row(left, s, 22, 34));
      const houseRow = row(left, s, 38, 49).filter((it) => it.x > s.x + 33);
      const ageRow = row(cell, s, 50, 58);
      const age = (ageRow.find((it) => /^\d{1,3}$/.test(it.str.trim()) && it.x < s.x + 45) || { str: '' }).str.trim();
      const sexText = text(ageRow.filter((it) => DEV.test(it.str)));
      const rel = REL.find(([k]) => relRow.startsWith(k));
      return {
        page: pageNo, y: s.y, box: parseInt(s.str, 10), marker, epic,
        house: text(houseRow).trim(), age,
        relation: rel ? rel[1] : '',
        gender: /पचरष/.test(sexText) ? 'पुरुष' : (/सल|सब/.test(sexText) ? 'स्त्री' : ''),
        nameSkel: afterColon(nameRow), relSkel: afterColon(relRow),
        cell: { x0: s.x - 14, x1: s.x + 150, y0: s.y - 61, y1: s.y + 14 },   // for cropping the card image
      };
    });
    // section headings ("घटक 1: परिवर्धन सूची" …), one per text line outside the cards
    const lines = new Map();
    for (const it of items) {
      if (serials.some((s) => inCell(it, s))) continue;
      const k = Math.round(it.y);
      lines.set(k, (lines.get(k) || []).concat(it));
    }
    const heads = [];
    for (const [y, its] of lines) {
      const m = text(its.sort((a, b) => a.x - b.x)).match(/घटक\s*(\d)/);
      if (m && SECTION[m[1]]) heads.push({ page: pageNo, y, section: SECTION[m[1]] });
    }
    return { cards, heads };
  }

  function headerOf(items) {
    const lines = new Map();
    for (const it of items) { const k = Math.round(it.y); lines.set(k, (lines.get(k) || []).concat(it)); }
    const h = {};
    for (const its of lines.values()) {
      const right = text(its.filter((it) => it.x > 290).sort((a, b) => a.x - b.x));
      let m;
      if ((m = right.match(/^ररडर\s*कमरपक\s*:\s*(\d+)/))) h.ward = m[1];
      else if ((m = right.match(/^नज॰\s*प॰.*?:\s*(\d+)/))) h.zp = m[1];
      else if ((m = right.match(/^पप॰\s*स॰.*?:\s*(\d+)/))) h.ps = m[1];
    }
    return h;
  }

  // Cover page: "मतदान बूथ की संख्या एवं पता : 54 - राजकीय …" — the number is exact, the name only a skeleton
  function boothOf(items, pageNo) {
    const lines = new Map();
    for (const it of items) { const k = Math.round(it.y); lines.set(k, (lines.get(k) || []).concat(it)); }
    for (const [y, its] of lines) {
      const t = text(its.sort((a, b) => a.x - b.x));
      if (!/^मतदरन\s*बडस/.test(t)) continue;
      const m = afterColon(t).match(/^(\d+)\s*-?\s*(.*)$/);
      if (m) return { page: pageNo, no: m[1], skel: m[2], cell: { x0: its[0].x - 6, x1: 570, y0: y - 8, y1: y + 14 } };
    }
    return null;
  }

  async function read(pdfjsLib, bytes) {
    const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true }).promise;
    const pages = [], all = [], heads = [];
    let header = {}, booth = null;
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      const items = tc.items.filter((it) => it.str && it.str.trim())
        .map((it) => ({ str: it.str, font: it.fontName, x: it.transform[4], y: it.transform[5] }));
      if (p === 1) header = headerOf(items);
      if (!booth) booth = boothOf(items, p);
      const r = pageCards(items, p);
      pages.push(r.cards.length);
      all.push(...r.cards); heads.push(...r.heads);
    }
    // walk headings and cards in reading order to tag each card with its list part
    const ev = heads.map((h) => ({ k: [h.page, -h.y, 0], h })).concat(all.map((c) => ({ k: [c.page, -c.y, 1], c })));
    ev.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2]);
    let section = 'main';
    for (const e of ev) if (e.h) section = e.h.section; else e.c.section = section;
    await doc.destroy();
    return { header, booth, cards: all, pageCount: pages.length, cardsPerPage: pages };
  }

  // ---------- name check ----------
  // What a correctly spelled name looks like in the text layer: vowel signs map to stand-in letters
  // (the supplement pages use a slightly different font, hence `supp`), ि is printed before its consonant.
  // Signs that come out as one of a few letters (or nothing) become wildcards that match only those letters.
  // The SEC PDFs use two versions of the font, which print द्र differently.
  const WILD = { '\uE001': 'नदल', '\uE002': 'जगहतरन', '\uE003': 'खजगह', '\uE004': 'जमसभन', '\uE005': 'गदसय', '\uE006': 'पसत', '\uE007': 'भखसड' };
  // Two more kinds, built per letter: a doubled letter (म्म) is printed once or twice, and ै ँ ों are
  // sometimes printed as a repeat of the letter before them.
  const DUP = 0xE100, DUP_OR = 0xE180, DUP_ALSO = 'जमसभनडखश';
  const dup = (base, c) => String.fromCharCode(base + c.charCodeAt(0) - 0x900);
  function wild(c) {
    if (WILD[c]) return WILD[c];
    const k = c.charCodeAt(0);
    if (k >= DUP && k < DUP_OR) return String.fromCharCode(0x900 + k - DUP);
    if (k >= DUP_OR && k < DUP_OR + 0x80) return String.fromCharCode(0x900 + k - DUP_OR) + DUP_ALSO;
    return '';
  }
  const lig = (pairs) => pairs.map(([a, b]) => [a.normalize('NFD'), b]);
  const LIGS = [['ें', '\uE002'], ['ीं', '\uE003'], ['क्ष', 'क'], ['क्त', 'क'], ['द्य', 'द'], ['द्ध', 'द'], ['व्य', '\uE009'], ['ज्ञ', 'ज'], ['रू', 'र']];
  const LIG = [lig([...LIGS, ['द्र', 'न']]), lig([...LIGS, ['द्र', 'द']])];
  function skel(s, supp, v = 0) {
    const m = { 'ा': 'र', 'ी': supp ? 'ब' : 'ल', 'ु': 'च', 'ू': 'ड', 'े': supp ? 'क' : 'न', 'ै': '\uE004', 'ो': 'य', 'ौ': '\uE005',
      'ं': 'प', 'ँ': '\uE007', 'ॉ': '\uE007', '्': '', '़': '', 'ृ': '\uE006', 'ः': '', 'य': 'ज', 'व': 'र', '\uE009': 'व' };   // व prints as र, but व्य as व
    let t = s.normalize('NFD').replace(/([क-ह])्\1/g, (x, c) => c + dup(DUP, c));   // doubled consonants (दत्त, उम्मेद)
    for (const [a, b] of LIG[v]) t = t.split(a).join(b);
    t = t.replace(/([\u0915-\u0939])\u094D\u0930/g, '$1')       // र-phala (प्र, श्री) is not printed as a letter
      .replace(/\u0930\u094D([\u0915-\u0939])/g, '$1\u0930');   // reph (र्ष) comes after its consonant
    const out = [];
    t = t.replace(/\u093F\u0902/g, '\u093F')   // the bindu of सिं is part of the ि glyph
      .replace(/\u094B\u0902/g, '\u0901');       // ों prints like ँ
    for (const ch of t) {
      if (ch === 'ि' && out.length) { out.splice(out.length - 1, 0, '\uE001'); continue; }   // printed before its consonant, as न or द
      if (ch === 'ै' || ch === 'ँ') {
        const last = [...out].reverse().find((c) => c >= '\u0915' && c <= '\u0939');
        out.push(last ? dup(DUP_OR, last) : m[ch]);
        continue;
      }
      out.push(ch in m ? m[ch] : ch);
    }
    return out.join('');
  }
  // drop the letters the font map is unreliable on (they stand in for vowel signs); थ often prints as स, छ as च,
  // and one form of ा as a danda (प्रस।द)
  const norm = (s) => s.normalize('NFD').replace(/।/g, 'र').replace(/थ/g, 'स').replace(/छ/g, 'च').replace(/[(),.\-\s़रनलपवबकयच॰]/g, '');
  // Similarity 2·matches / (len a + len b), where a wildcard in `a` may match one of its letters in `b` or nothing
  // (an unmatched wildcard does not count towards the length).
  function ratio(a, b) {
    a = [...a]; b = [...b];
    const fixed = a.filter((c) => !wild(c)).length;
    if (!fixed && !b.length) return 1;
    // dp value: matches * 64 - wildcard matches (more matches first, then fewer wildcards used)
    let dp = Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      const nx = Array(b.length + 1).fill(0), w = wild(a[i - 1]);
      for (let j = 1; j <= b.length; j++) {
        let v = Math.max(dp[j], nx[j - 1]);
        if (a[i - 1] === b[j - 1]) v = Math.max(v, dp[j - 1] + 64);
        else if (w && w.includes(b[j - 1])) v = Math.max(v, dp[j - 1] + 63);
        nx[j] = v;
      }
      dp = nx;
    }
    const v = dp[b.length], M = Math.ceil(v / 64), W = M * 64 - v;
    return (2 * M) / (fixed + W + b.length);
  }
  // 0..1: how well a Hindi name fits the PDF's skeleton for it
  function nameScore(name, pdfSkel) {
    const b = norm(pdfSkel || '');
    let best = 0;
    for (const supp of [false, true]) for (const v of [0, 1]) best = Math.max(best, ratio(norm(skel(name || '', supp, v)), b));
    return best;
  }

  // Like nameScore but keeps the vowel stand-ins, so it can tell मागी from मगी (used to pick a spelling)
  const loose = (s) => s.normalize('NFD').replace(/।/g, 'र').replace(/थ/g, 'स').replace(/छ/g, 'च').replace(/[\s\u093C\u0970(),.\-]/g, '');
  function exactScore(name, pdfSkel) {
    const b = loose(pdfSkel || '');
    let best = 0;
    for (const supp of [false, true]) for (const v of [0, 1]) best = Math.max(best, ratio(loose(skel(name || '', supp, v)), b));
    return best;
  }

  // ---------- letter repair ----------
  // The PDF's consonants are reliable, Gemini's vowel signs usually are. Try up to two letter changes to a name
  // Gemini read (swap a consonant for one the PDF has there, drop or add a letter) until it fits the PDF exactly.
  // Returns the fixed name, or null when nothing fits or two different fixes fit equally well.
  const CONS = /^[क-ह]$/, SIGN = /^[ा-्ँ-ः़]$/;
  const PRINTED_AS = [['र', 'व'], ['ज', 'य'], ['स', 'थ'], ['च', 'छ']];   // the PDF prints the second as the first
  function wellFormed(ch) {
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i], prev = ch[i - 1];
      if (SIGN.test(c) && (i === 0 || prev === ' ' || (SIGN.test(prev) && !(prev === '़' || c === 'ं' || c === 'ँ')))) return false;
      if (c === '्' && (!CONS.test(prev || '') && prev !== '़' || !CONS.test(ch[i + 1] || ''))) return false;
    }
    return true;
  }
  // A fix keeps Gemini's joined letters as they are (guesses like न्न्र, प्न are too often wrong):
  // same number of ् and no new doubled letter (न्न).
  const shape = (w) => `${(w.match(/\u094D/g) || []).length}/${(w.match(/([\u0915-\u0939])\u094D\1/g) || []).length}`;
  function repair(name, pdfSkel) {
    if (!name || !pdfSkel) return null;
    const pool = [...new Set([...pdfSkel.normalize('NFD')].filter((c) => CONS.test(c)))];
    for (const [a, b] of PRINTED_AS) if (pool.includes(a)) pool.push(b);
    const start = name.normalize('NFD'), startShape = shape(start);
    const seen = new Set([start]);
    let level = [start];
    const found = [];
    for (let d = 1; d <= 2 && !found.length; d++) {
      const next = [];
      for (const w of level) {
        const ch = [...w];
        const tries = [];
        for (let i = 0; i <= ch.length; i++) {
          if (i < ch.length) {
            if (CONS.test(ch[i])) for (const c of pool) if (c !== ch[i]) tries.push([...ch.slice(0, i), c, ...ch.slice(i + 1)]);
            if (CONS.test(ch[i])) tries.push([...ch.slice(0, i), ...ch.slice(i + 1)]);   // drop a letter, not a vowel sign
          }
          if (d === 1) for (const c of pool) tries.push([...ch.slice(0, i), c, ...ch.slice(i)]);
        }
        for (const t of tries) {
          const k = t.join('');
          if (seen.has(k) || !wellFormed(t) || shape(k) !== startShape) continue;
          seen.add(k); next.push(k);
          if (nameScore(k, pdfSkel) === 1) found.push(k);
        }
      }
      level = next;
    }
    if (!found.length) return null;
    const scored = [...new Set(found.map((x) => x.normalize('NFC')))].map((x) => [x, exactScore(x, pdfSkel)]).sort((a, b) => b[1] - a[1]);
    if (scored.length > 1 && scored[1][1] === scored[0][1]) return null;
    return scored[0][0];
  }

  const api = { read, nameScore, exactScore, skel, repair };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PdfText = api;
})(typeof self !== 'undefined' ? self : this);
