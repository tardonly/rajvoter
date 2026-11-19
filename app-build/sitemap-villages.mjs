// Writes one <url> per village (www.rajelection.com/<village>) into voter-search-app/sitemap.xml, between the
// "villages" comments, from api/_villages.json. Run it again after villages are added (app-build/encrypt.mjs):
//   node app-build/sitemap-villages.mjs
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const app = join(dirname(fileURLToPath(import.meta.url)), '..', 'voter-search-app');
const file = join(app, 'sitemap.xml');
const villages = Object.keys(JSON.parse(readFileSync(join(app, 'api', '_villages.json'), 'utf8'))).sort();
const today = new Date().toISOString().slice(0, 10);
const START = '  <!-- villages: written by app-build/sitemap-villages.mjs -->\n', END = '  <!-- /villages -->\n';
const block = START + villages.map((s) => `  <url>\n    <loc>https://www.rajelection.com/${s}</loc>\n    <lastmod>${today}</lastmod>\n  </url>\n`).join('') + END;

let xml = readFileSync(file, 'utf8');
const a = xml.indexOf(START), b = xml.indexOf(END);
xml = a >= 0 && b > a ? xml.slice(0, a) + block + xml.slice(b + END.length) : xml.replace('</urlset>', block + '</urlset>');
writeFileSync(file, xml);
console.log(`sitemap.xml: ${villages.length} villages, ${Buffer.byteLength(xml)} bytes`);
