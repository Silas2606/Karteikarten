#!/usr/bin/env node
// Prüft alle Kartensets auf gültiges Format, eindeutige IDs und Duplikate.
// Aufruf: node scripts/validate.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];

const index = JSON.parse(readFileSync(join(root, 'decks/index.json'), 'utf8'));

for (const meta of index.decks) {
  const file = `decks/${meta.id}.json`;
  let deck;
  try {
    deck = JSON.parse(readFileSync(join(root, file), 'utf8'));
  } catch (e) {
    errors.push(`${file}: ${e.message}`);
    continue;
  }
  if (deck.deck !== meta.id) errors.push(`${file}: "deck" muss "${meta.id}" sein`);
  if (!Array.isArray(deck.cards)) { errors.push(`${file}: "cards" fehlt`); continue; }

  const ids = new Set();
  const fronts = new Map();
  const idPattern = new RegExp(`^${meta.prefix}-\\d{4}$`);
  deck.cards.forEach((c, i) => {
    const where = `${file} Karte #${i + 1} (${c.id ?? 'ohne id'})`;
    if (!c.id || !idPattern.test(c.id)) errors.push(`${where}: id muss das Format ${meta.prefix}-0001 haben`);
    if (ids.has(c.id)) errors.push(`${where}: id doppelt`);
    ids.add(c.id);
    for (const f of ['front', 'back', 'topic', 'source']) {
      if (typeof c[f] !== 'string' || !c[f].trim()) errors.push(`${where}: Feld "${f}" fehlt oder ist leer`);
    }
    const norm = String(c.front ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (fronts.has(norm)) warnings.push(`${where}: gleiche Frage wie ${fronts.get(norm)}`);
    else fronts.set(norm, c.id);
  });
  console.log(`${meta.name}: ${deck.cards.length} Karten`);
}

warnings.forEach((w) => console.warn(`Warnung: ${w}`));
if (errors.length) {
  errors.forEach((e) => console.error(`Fehler: ${e}`));
  process.exit(1);
}
console.log('OK');
