// Bumpea la versión de la app en los 2 lugares que tienen que coincidir SIEMPRE:
// version.json (lo que la app chequea por red) y la constante APP_VERSION en
// index.html (lo que la app cree tener cargado). Si se desincronizan, la app
// puede quedar recargándose sin parar (o nunca detectar que hay una nueva).
//
// Uso: node worker/bump-version.js   (correr antes de cada commit/deploy)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const versionFile = path.join(root, 'version.json');
const indexFile = path.join(root, 'index.html');

const nueva = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  .replace(/^(\d{8})(\d{6})$/, '$1-$2');

fs.writeFileSync(versionFile, JSON.stringify({ v: nueva }) + '\n');

let html = fs.readFileSync(indexFile, 'utf8');
const re = /const APP_VERSION = '[^']*';/;
if (!re.test(html)) {
  console.error('No se encontró "const APP_VERSION = ...;" en index.html — no se modificó nada.');
  process.exit(1);
}
html = html.replace(re, `const APP_VERSION = '${nueva}';`);
fs.writeFileSync(indexFile, html);

console.log('Versión actualizada a', nueva, 'en version.json e index.html');
