// Baixa woff2 (latin + latin-ext) do Google Fonts e gera src/styles/fonts.css com @font-face locais.
// Rodar: node scripts/fetch-fonts.mjs   Send (send.hx-corp.com). Origem: repo ja-painel-comercial, padrao DESIGN.md
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// Google serve UM arquivo variavel por familia/subset; os pesos declarados usam o mesmo woff2.
const families = [
  { css: 'family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800', slug: 'bricolage' },
  { css: 'family=Geist:wght@400;500;600;700', slug: 'geist' },
  { css: 'family=Geist+Mono:wght@400;500;600', slug: 'geist-mono' },
];

mkdirSync(new URL('../public/assets/fonts/', import.meta.url), { recursive: true });

let out = '/* gerado por scripts/fetch-fonts.mjs (Google Fonts, latin + latin-ext, self-host) */\n';
let n = 0;
const seen = new Map(); // url -> arquivo

for (const f of families) {
  const css = await (await fetch(`https://fonts.googleapis.com/css2?${f.css}&display=swap`, { headers: { 'user-agent': UA } })).text();
  const re = /\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
  let mm;
  while ((mm = re.exec(css))) {
    const subset = mm[1]; const b = mm[2];
    if (!['latin', 'latin-ext'].includes(subset)) continue;
    const url = (b.match(/url\((https:[^)]+\.woff2)\)/) || [])[1];
    const family = (b.match(/font-family:\s*'([^']+)'/) || [])[1];
    const style = (b.match(/font-style:\s*(\w+)/) || [])[1] || 'normal';
    const weight = (b.match(/font-weight:\s*([\d ]+)/) || [])[1] || '400';
    const range = (b.match(/unicode-range:\s*([^;]+);?/) || [])[1];
    if (!url) continue;
    let file = seen.get(url);
    if (!file) {
      file = `${f.slug}-${weight.replace(/\s+/g, '-')}-${subset}.woff2`;
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      writeFileSync(new URL(`../public/assets/fonts/${file}`, import.meta.url), buf);
      seen.set(url, file);
      n++;
    }
    out += `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};font-display:swap;src:url('/assets/fonts/${file}') format('woff2');unicode-range:${range};}\n`;
  }
}
writeFileSync(new URL('../src/styles/fonts.css', import.meta.url), out);
console.log('arquivos baixados:', n);
