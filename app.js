'use strict';

// ---------- Konstanten & Speicher ----------

const STORAGE_KEY = 'karteikarten-progress-v1';
const SESSION_KEY = 'karteikarten-session';
const MIGRATED_KEY = 'karteikarten-progress-v1-uebernommen';
const DAY = 24 * 60 * 60 * 1000;

const app = document.getElementById('app');
let DECKS = []; // [{id, name, prefix, color, cards: [...]}]

function defaultProgress() {
  // log: Lernstatistik dieses Geräts, otherLogs: die der anderen Geräte (per Sync)
  return { version: 1, cards: {}, log: {}, otherLogs: {}, newIntroduced: {}, settings: { updatedAt: 0 } };
}

// ---------- Logins (Supabase) ----------
// Mit config.js (Supabase-URL + öffentlicher Schlüssel) braucht jede Person einen Login-Code,
// den der Admin in der Datenbank anlegt. Der Fortschritt liegt dann pro Login auf dem Server
// (Cache pro Login im Browser). Ohne config.js läuft die App ohne Login.

const CONFIG = window.KK_CONFIG || {};
const ACCOUNTS = !!(CONFIG.supabaseUrl && CONFIG.supabaseKey);

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}

let session = ACCOUNTS ? loadSession() : null; // { code, name }

function setSession(s) {
  session = s;
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch (e) { console.warn(e); }
  renderUserBadge();
}

function normalizeCode(code) { return String(code || '').trim().toLowerCase(); }

function progressKey() { return session ? `${STORAGE_KEY}:${session.code}` : STORAGE_KEY; }

async function rpc(fn, args) {
  const headers = { 'Content-Type': 'application/json', apikey: CONFIG.supabaseKey };
  // Ältere "anon"-Schlüssel sind JWTs und gehören zusätzlich in den Authorization-Header
  if (!CONFIG.supabaseKey.startsWith('sb_')) headers.Authorization = `Bearer ${CONFIG.supabaseKey}`;
  let res;
  try {
    res = await fetch(`${CONFIG.supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers, body: JSON.stringify(args), cache: 'no-store',
    });
  } catch {
    throw new Error('Keine Verbindung zum Server');
  }
  if (!res.ok) throw new Error(`Server antwortet mit HTTP ${res.status}`);
  return res.json();
}

function renderUserBadge() {
  const el = document.getElementById('user-badge');
  if (!el) return;
  el.hidden = !session;
  el.innerHTML = session ? `<span class="avatar">${esc(session.name.charAt(0).toUpperCase())}</span><span>${esc(session.name)}</span>` : '';
}

function loadProgress(key = progressKey()) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaultProgress();
    const p = JSON.parse(raw);
    const d = defaultProgress();
    return { ...d, ...p, settings: { ...d.settings, ...(p.settings || {}) } };
  } catch (e) {
    console.warn('Fortschritt konnte nicht gelesen werden', e);
    return defaultProgress();
  }
}

let progress = loadProgress();

function saveProgress() {
  try {
    localStorage.setItem(progressKey(), JSON.stringify(progress));
  } catch (e) {
    console.warn('Fortschritt konnte nicht gespeichert werden', e);
  }
}

// Tageslog aller Geräte zusammengezählt
function combinedLog() {
  const out = {};
  for (const log of [progress.log, ...Object.values(progress.otherLogs || {})]) {
    for (const [day, l] of Object.entries(log || {})) {
      const o = out[day] || (out[day] = { reviews: 0, correct: 0 });
      o.reviews += l.reviews;
      o.correct += l.correct;
    }
  }
  return out;
}

function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function cardKey(deckId, cardId) { return `${deckId}/${cardId}`; }
function stateOf(deckId, cardId) { return progress.cards[cardKey(deckId, cardId)]; }

// Kartenzustand: { reps, lapses, known, marked, last }
// reps = wie oft beantwortet, lapses = wie oft "Wiederholen", known = "Kann ich" (raus aus dem Zyklus)
function isKnown(st) {
  if (!st) return false;
  if (typeof st.known === 'boolean') return st.known;
  return st.interval >= 21; // Stand aus der früheren Spaced-Repetition-Version
}

function status(st) {
  if (isKnown(st)) return 'mastered';
  return st && (st.reps || st.lapses) ? 'learning' : 'new';
}
const STATUS_LABEL = { new: 'neu', learning: 'wiederholen', mastered: 'gekonnt' };

function updateCard(deckId, cardId, change) {
  const key = cardKey(deckId, cardId);
  const st = { reps: 0, lapses: 0, ...progress.cards[key] };
  change(st);
  st.last = Date.now();
  progress.cards[key] = st;
  saveProgress();
  scheduleSync();
  return st;
}

function recordAnswer(deckId, card, knew) {
  updateCard(deckId, card.id, (st) => {
    st.reps += 1;
    st.known = knew;
    if (!knew) st.lapses += 1;
  });
  const t = todayKey();
  const log = progress.log[t] || (progress.log[t] = { reviews: 0, correct: 0 });
  log.reviews += 1;
  if (knew) log.correct += 1;
  saveProgress();
}

function toggleMark(deckId, cardId) {
  return updateCard(deckId, cardId, (st) => { st.marked = !st.marked; }).marked;
}

function relearn(deckId, cardId) {
  updateCard(deckId, cardId, (st) => { st.known = false; });
}

// Gelöschte Karten bleiben in decks/*.json, werden aber überall ausgeblendet (per Sync auf allen Geräten)
function setDeleted(deckId, cardId, deleted) {
  updateCard(deckId, cardId, (st) => { st.deleted = deleted; });
}

function activeCards(deck) {
  return deck.cards.filter((c) => !stateOf(deck.id, c.id)?.deleted);
}

// Löschen mit doppelter Bestätigung in einem Dialog; ruft onDeleted() nach dem zweiten "Ja"
function confirmDelete(deckId, card, onDeleted) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  // Tasten nicht an den Lernmodus durchreichen, solange der Dialog offen ist
  const onKey = (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const step = (n) => {
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <h3>${n === 1 ? 'Karte löschen?' : 'Wirklich endgültig löschen?'}</h3>
      <p class="front-preview">${esc(card.front.split('\n')[0])}</p>
      <p class="small muted">${n === 1
        ? 'Die Karte verschwindet aus allen Lernmodi, der Kartenliste und der Statistik.'
        : `Bitte bestätige ein zweites Mal. Die Löschung gilt auch auf deinen anderen Geräten. Wiederherstellen kannst du sie nur noch unter ${ACCOUNTS ? 'Konto' : 'Einstellungen'} → Gelöschte Karten.`}</p>
      <div class="toolbar" style="justify-content:flex-end;margin-top:4px">
        <button id="cancel">Abbrechen</button>
        <button class="danger" id="confirm">${icon('trash')}${n === 1 ? 'Löschen' : 'Endgültig löschen'}</button>
      </div>
    </div>`;
    overlay.querySelector('#cancel').addEventListener('click', close);
    overlay.querySelector('#confirm').addEventListener('click', () => {
      if (n === 1) return step(2);
      setDeleted(deckId, card.id, true);
      close();
      onDeleted();
    });
    overlay.querySelector('#cancel').focus();
  };
  step(1);
}

// ---------- Daten laden ----------

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function loadDecks() {
  const index = await fetchJson('decks/index.json');
  DECKS = await Promise.all(index.decks.map(async (meta) => {
    try {
      const data = await fetchJson(`decks/${meta.id}.json`);
      return { ...meta, cards: data.cards || [] };
    } catch (e) {
      console.error(e);
      return { ...meta, cards: [], error: e.message };
    }
  }));
}

function deckById(id) { return DECKS.find((d) => d.id === id); }

// ---------- Rendering-Helfer ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Mini-Markdown: **fett**, *kursiv*, `code`, Listen (- / 1.), Absätze. Formeln in $…$ bleiben für KaTeX erhalten.
function md(text) {
  const math = [];
  let s = esc(text).replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, (m) => { math.push(m); return `\u0000${math.length - 1}\u0000`; });
  s = s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // Absätze; innerhalb eines Absatzes werden aufeinanderfolgende "- " / "1. "-Zeilen zu Listen
  const blocks = s.split(/\n{2,}/).map((block) => {
    const out = [];
    let para = [];
    let list = null;
    const flushPara = () => { if (para.length) out.push(`<p>${para.join('<br>')}</p>`); para = []; };
    const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`); list = null; };
    for (const line of block.split('\n')) {
      const m = line.match(/^\s*(?:([-•])|\d+[.)])\s+(.*)$/);
      if (m) {
        const tag = m[1] ? 'ul' : 'ol';
        flushPara();
        if (list?.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(m[2]);
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
    return out.join('');
  });
  return blocks.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => math[i]);
}

function renderMath(el) {
  if (window.renderMathInElement) {
    window.renderMathInElement(el, {
      delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
      throwOnError: false,
    });
  }
}

function deckStats(deck, topic) {
  const r = { total: 0, new: 0, learning: 0, mastered: 0, open: 0, marked: 0 };
  for (const c of activeCards(deck)) {
    if (topic && c.topic !== topic) continue;
    const st = stateOf(deck.id, c.id);
    r.total += 1;
    r[status(st)] += 1;
    if (!isKnown(st)) r.open += 1;
    if (st?.marked) r.marked += 1;
  }
  return r;
}

function progressBar(s) {
  const pct = (n) => (s.total ? (n / s.total) * 100 : 0);
  return `<div class="bar" title="${s.mastered} gekonnt, ${s.learning} wiederholen, ${s.new} neu">
    <span class="mastered" style="width:${pct(s.mastered)}%"></span>
    <span class="learning" style="width:${pct(s.learning)}%"></span>
  </div>`;
}

function legend() {
  return `<div class="legend">
    <span><i style="background:var(--good)"></i>gekonnt</span>
    <span><i style="background:var(--hard)"></i>wiederholen</span>
    <span><i style="background:var(--border)"></i>neu</span>
  </div>`;
}

function studyHref(deckId, topic, mode) {
  const params = new URLSearchParams();
  if (topic) params.set('thema', topic);
  if (mode) params.set('modus', mode);
  const q = params.toString();
  return `#/lernen/${deckId}${q ? `?${q}` : ''}`;
}

function linkBtn(href, label, { primary = false, disabled = false, iconName = '', cls = '' } = {}) {
  return `<a class="btn${primary ? ' primary' : ''}${cls ? ` ${cls}` : ''}" href="${href}"${disabled ? ' aria-disabled="true" tabindex="-1"' : ''}>${iconName ? icon(iconName) : ''}${label}</a>`;
}

function topicsOf(deck) {
  return [...new Set(activeCards(deck).map((c) => c.topic).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
}

function streak() {
  const log = combinedLog();
  let n = 0;
  let t = Date.now();
  if (!log[todayKey(t)]) t -= DAY; // heute noch nicht gelernt: Serie zählt ab gestern
  while (log[todayKey(t)]) { n += 1; t -= DAY; }
  return n;
}

// ---------- Symbole & kleine Effekte ----------

// Strich-Symbole im Stil von Lucide (24er Raster)
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/><path d="M10 11v6M14 11v6"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  repeat: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  play: '<path d="m7 4 13 8-13 8z"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  flame: '<path d="M12 22c4 0 7-2.7 7-7 0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-5 5-5 8 0 4.3 3 7 7 7z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.5A4 4 0 0 0 6 19z"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
};

function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Kurzes haptisches Feedback (Android/Chrome; iOS ignoriert es)
function haptic(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* nicht unterstützt */ }
}

// Zahlen mit data-count beim Anzeigen hochzählen
function countUp(root) {
  root.querySelectorAll('[data-count]').forEach((el) => {
    const target = Number(el.dataset.count);
    const suffix = el.dataset.suffix || '';
    if (REDUCED_MOTION || !target) { el.textContent = target + suffix; return; }
    const start = performance.now();
    const dur = 700;
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      el.textContent = Math.round(target * (1 - Math.pow(1 - t, 3))) + suffix;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function tile(iconName, label, value, { suffix = '', extra = '', cls = '' } = {}) {
  return `<div class="tile ${cls}">
    <span class="tile-label">${icon(iconName)}${label}</span>
    <b><span data-count="${value}" data-suffix="${suffix}">${value}${suffix}</span>${extra}</b>
  </div>`;
}

function pct(n, total) { return total ? Math.round((n / total) * 100) : 0; }

function deckInitials(name) {
  return name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

// ---------- Seiten ----------

function viewOverview() {
  const today = combinedLog()[todayKey()] || { reviews: 0 };
  const totals = DECKS.reduce((acc, d) => {
    const s = deckStats(d);
    for (const k in s) acc[k] = (acc[k] || 0) + s[k];
    return acc;
  }, {});
  const hour = new Date().getHours();
  const greet = hour < 11 ? 'Guten Morgen' : hour < 18 ? 'Hallo' : 'Guten Abend';

  app.innerHTML = `
    <div class="page-head">
      <h1>${session ? `${greet}, ${esc(session.name)}` : 'Deine Module'}</h1>
      <p>${totals.open ? `${totals.open} Karten warten auf dich.` : totals.total ? 'Alles gekonnt – stark!' : 'Noch keine Karten vorhanden.'}</p>
    </div>
    <div class="tiles">
      ${tile('inbox', 'Offen', totals.open || 0)}
      ${tile('check', 'Heute gelernt', today.reviews)}
      ${tile('flame', 'Tage Serie', streak(), { cls: 'flame' })}
      ${tile('target', 'Gekonnt', pct(totals.mastered || 0, totals.total || 0), { suffix: ' %', extra: ` <small>${totals.mastered || 0}/${totals.total || 0}</small>` })}
    </div>
    <div class="grid">
      ${DECKS.map((d) => {
        const s = deckStats(d);
        return `<div class="panel deck" style="--deck:${d.color}">
          <div class="deck-head">
            <div class="deck-icon">${deckInitials(d.name)}</div>
            <div>
              <h3>${esc(d.name)}</h3>
              <div class="sub">${s.total} Karten</div>
            </div>
            ${s.total ? `<div class="deck-pct">${pct(s.mastered, s.total)} %<small>gekonnt</small></div>` : ''}
          </div>
          ${d.error ? `<p class="small" style="color:var(--again);margin:0">Fehler beim Laden: ${esc(d.error)}</p>` : ''}
          ${s.total === 0
            ? '<p class="empty">Noch keine Karten. Lade ein Dokument bei Claude hoch, um Karten zu erzeugen.</p>'
            : `${progressBar(s)}
              <div class="deck-meta">
                <span>${s.open} offen</span><span>${s.mastered} gekonnt</span>${s.marked ? `<span class="star">${icon('star', 'fill')}${s.marked}</span>` : ''}
              </div>`}
          <div class="actions">
            ${linkBtn(studyHref(d.id), `Lernen${s.open ? ` · ${s.open}` : ''}`, { primary: true, disabled: !s.open, iconName: 'play' })}
            ${linkBtn(`#/deck/${d.id}`, 'Karten', { iconName: 'layers' })}
          </div>
        </div>`;
      }).join('')}
    </div>
    ${legend()}
  `;
  countUp(app);
}

const FILTERS = { '': 'Alle Karten', offen: 'Offen', gekonnt: 'Gekonnt', markiert: 'Markiert' };

function viewDeck(deckId) {
  const deck = deckById(deckId);
  if (!deck) return viewNotFound();
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const topic = params.get('thema') || '';
  const filter = params.get('filter') || '';
  const topics = topicsOf(deck);
  const s = deckStats(deck, topic);
  const cards = activeCards(deck).filter((c) => {
    if (topic && c.topic !== topic) return false;
    const st = stateOf(deck.id, c.id);
    if (filter === 'offen') return !isKnown(st);
    if (filter === 'gekonnt') return isKnown(st);
    if (filter === 'markiert') return !!st?.marked;
    return true;
  });

  const navigate = (t, f) => {
    const q = new URLSearchParams();
    if (t) q.set('thema', t);
    if (f) q.set('filter', f);
    location.hash = `#/deck/${deck.id}${q.toString() ? `?${q}` : ''}`;
  };

  app.innerHTML = `
    <a class="back-link" href="#/">${icon('back')}Übersicht</a>
    <div class="page-head">
      <h1>${esc(deck.name)}</h1>
      <p>${s.total} Karten${topic ? ` im Thema „${esc(topic)}“` : ''}</p>
    </div>
    <div class="panel deck-hero" style="--deck:${deck.color}">
      <div class="row">
        <label class="field">Thema
          <select id="topic">
            <option value="">Alle Themen</option>
            ${topics.map((t) => `<option ${t === topic ? 'selected' : ''}>${esc(t)}</option>`).join('')}
          </select>
        </label>
        <div class="deck-pct">${pct(s.mastered, s.total)} %<small>gekonnt</small></div>
      </div>
      ${progressBar(s)}
      <div class="deck-meta"><span>${s.open} offen</span><span>${s.mastered} gekonnt</span><span class="star">${icon('star', 'fill')}${s.marked} markiert</span></div>
      <div class="study-actions">
        ${linkBtn(studyHref(deck.id, topic), `Offene lernen · ${s.open}`, { primary: true, disabled: !s.open, iconName: 'play' })}
        ${linkBtn(studyHref(deck.id, topic, 'alle'), `Alle Karten · ${s.total}`, { disabled: !s.total, iconName: 'layers' })}
        ${linkBtn(studyHref(deck.id, topic, 'markiert'), `Markierte · ${s.marked}`, { disabled: !s.marked, iconName: 'star' })}
      </div>
    </div>
    <div class="list-head">
      <h2>Karten</h2>
      <select id="filter" aria-label="Filter">
        ${Object.entries(FILTERS).map(([k, v]) => `<option value="${k}" ${k === filter ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </div>
    <div class="card-list">
      ${cards.length === 0 ? '<p class="muted">Keine Karten vorhanden.</p>' : cards.map((c) => {
        const st = stateOf(deck.id, c.id);
        const stat = status(st);
        return `<details data-id="${esc(c.id)}">
          <summary><span class="q">${st?.marked ? `<span class="star">${icon('star', 'fill')}</span>` : ''}<span>${esc(c.front.split('\n')[0])}</span></span><span class="pill ${stat}">${STATUS_LABEL[stat]}</span></summary>
          <div class="content">${md(c.back)}
            <p class="small muted" style="margin:10px 0 0">${esc([c.topic, c.source].filter(Boolean).join(' · '))}</p>
            <div class="toolbar" style="margin-top:12px">
              <button class="small" data-action="mark">${icon('star', st?.marked ? 'fill' : '')}${st?.marked ? 'Markierung entfernen' : 'Markieren'}</button>
              ${isKnown(st) ? `<button class="small" data-action="relearn">${icon('repeat')}Wieder in den Zyklus</button>` : ''}
              <button class="small danger-outline" data-action="delete">${icon('trash')}Löschen</button>
            </div>
          </div>
        </details>`;
      }).join('')}
    </div>
  `;
  app.querySelector('#topic').addEventListener('change', (e) => navigate(e.target.value, filter));
  app.querySelector('#filter').addEventListener('change', (e) => navigate(topic, e.target.value));
  app.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => {
    const id = b.closest('details').dataset.id;
    const rerender = (keepOpen) => {
      const y = window.scrollY;
      viewDeck(deck.id);
      if (keepOpen) app.querySelector(`details[data-id="${CSS.escape(id)}"]`)?.setAttribute('open', '');
      window.scrollTo(0, y);
    };
    if (b.dataset.action === 'delete') return confirmDelete(deck.id, deck.cards.find((c) => c.id === id), () => rerender(false));
    if (b.dataset.action === 'mark') toggleMark(deck.id, id);
    else relearn(deck.id, id);
    rerender(true);
  }));
  renderMath(app);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// offen (Standard): alles, was noch nicht "Kann ich" ist; alle: jede Karte; markiert: nur markierte
function buildQueue(deck, topic, mode) {
  const pool = activeCards(deck).filter((c) => !topic || c.topic === topic);
  if (mode === 'alle') return shuffle([...pool]);
  if (mode === 'markiert') return shuffle(pool.filter((c) => stateOf(deck.id, c.id)?.marked));
  return shuffle(pool.filter((c) => !isKnown(stateOf(deck.id, c.id))));
}

const MODE_LABEL = { offen: 'Offene Karten', alle: 'Alle Karten', markiert: 'Markierte Karten' };

let keyHandler = null;

function viewStudy(deckId) {
  const deck = deckById(deckId);
  if (!deck) return viewNotFound();
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const topic = params.get('thema') || '';
  const mode = params.get('modus') || 'offen';
  const queue = buildQueue(deck, topic, mode);
  const initial = queue.length;
  let knewCount = 0;
  let repeatCount = 0;
  let revealed = false;
  let busy = false;

  const backHref = `#/deck/${deck.id}${topic ? `?thema=${encodeURIComponent(topic)}` : ''}`;

  function finish() {
    const s = deckStats(deck, topic);
    const did = knewCount + repeatCount > 0;
    app.innerHTML = `<div class="done">
      <div class="done-badge${did ? '' : ' neutral'}">${icon(did ? 'check' : 'inbox')}</div>
      <h1>${did ? 'Runde geschafft' : 'Nichts zu lernen'}</h1>
      <p class="muted" style="margin:0">${did ? `${esc(deck.name)}${topic ? ` · ${esc(topic)}` : ''}`
        : mode === 'markiert' ? 'Keine markierten Karten.' : 'Alle Karten sind als „Kann ich“ markiert.'}</p>
      ${did ? `<div class="tiles">
        ${tile('check', 'Gekonnt', knewCount)}
        ${tile('repeat', 'Wiederholt', repeatCount)}
        ${tile('target', 'Modul gekonnt', pct(s.mastered, s.total), { suffix: ' %' })}
      </div>` : ''}
      <div class="toolbar">
        ${linkBtn(backHref, 'Zum Modul', { iconName: 'layers' })}
        ${s.total ? linkBtn(studyHref(deck.id, topic, 'alle'), 'Alle Karten lernen', { iconName: 'repeat' }) : ''}
        ${linkBtn('#/', 'Zur Übersicht', { primary: true, iconName: 'home' })}
      </div>
    </div>`;
    countUp(app);
    if (did) haptic([12, 80, 12]);
  }

  function show() {
    if (queue.length === 0) return finish();
    busy = false;
    revealed = false;
    const card = queue[0];
    const st = stateOf(deck.id, card.id);
    app.innerHTML = `
      <div class="study" style="--deck:${deck.color}">
        <div class="study-head">
          <a class="btn ghost icon-btn" href="${backHref}" aria-label="Lernrunde beenden">${icon('close')}</a>
          <div class="title">
            <b>${esc(deck.name)}${topic ? ` · ${esc(topic)}` : ''}</b>
            <span>${MODE_LABEL[mode] || ''}</span>
          </div>
          <span class="counter">${knewCount} / ${initial} gekonnt</span>
        </div>
        <div class="study-progress"><span style="width:${pct(knewCount, initial)}%"></span></div>

        <div class="card-tools">
          <span class="topic">${esc(card.topic || '')}</span>
          <div class="tools">
            <button class="small mark-btn ${st?.marked ? 'on' : ''}" id="mark" title="Markieren (Taste M)">${icon('star', st?.marked ? 'fill' : '')}<span>${st?.marked ? 'Markiert' : 'Markieren'}</span></button>
            <button class="small icon-btn danger-outline" id="delete" title="Karte löschen" aria-label="Karte löschen">${icon('trash')}</button>
          </div>
        </div>

        <div class="swipe enter" id="swipe">
          <span class="swipe-hint again">Wiederholen</span>
          <span class="swipe-hint good">Kann ich</span>
          <div class="flip-scene">
            <div class="flip-card" id="flip" role="button" tabindex="0" aria-label="Karte umdrehen">
              <div class="face front">
                <div class="q">${md(card.front)}</div>
                <div class="hint">${icon('hand')}Tippen zum Umdrehen</div>
              </div>
              <div class="face back">
                <div class="q-small">${md(card.front)}</div>
                <div class="a">${md(card.back)}</div>
                ${card.source ? `<div class="source">Quelle: ${esc(card.source)}</div>` : ''}
              </div>
            </div>
          </div>
        </div>

        <div class="answer-area">
          <button class="primary reveal" id="reveal">Antwort zeigen <kbd>Leertaste</kbd></button>
          <div class="answer-row">
            <button class="r-again" data-knew="0">${icon('repeat')}Wiederholen <kbd>1</kbd></button>
            <button class="r-good" data-knew="1">${icon('check')}Kann ich <kbd>2</kbd></button>
          </div>
        </div>
        <p class="kbd-hint">Nach dem Umdrehen wischen: → Kann ich · ← Wiederholen</p>
      </div>
    `;
    renderMath(app);
    const root = app.querySelector('.study');
    const flip = app.querySelector('#flip');
    const swipe = app.querySelector('#swipe');
    swipe.addEventListener('animationend', () => swipe.classList.remove('enter'), { once: true });

    const setRevealed = (v) => {
      revealed = v;
      flip.classList.toggle('flipped', v);
      if (v) root.classList.add('revealed');
    };
    const toggleFlip = () => { if (!busy) setRevealed(!revealed); };

    app.querySelector('#reveal').addEventListener('click', () => setRevealed(true));
    flip.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); toggleFlip(); } });
    app.querySelector('#mark').addEventListener('click', () => {
      const on = toggleMark(deck.id, card.id);
      const b = app.querySelector('#mark');
      b.classList.toggle('on', on);
      b.innerHTML = `${icon('star', on ? 'fill' : '')}<span>${on ? 'Markiert' : 'Markieren'}</span>`;
      haptic(8);
    });
    app.querySelector('#delete').addEventListener('click', () => confirmDelete(deck.id, card, () => {
      queue.shift(); // samt evtl. weiterer Vorkommen in der Runde entfernen
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === card.id) queue.splice(i, 1);
      show();
    }));
    app.querySelectorAll('[data-knew]').forEach((b) => b.addEventListener('click', () => answer(b.dataset.knew === '1')));

    // Wischen: erst nach dem Umdrehen; ein Tippen ohne Bewegung dreht die Karte
    const hints = { good: swipe.querySelector('.swipe-hint.good'), again: swipe.querySelector('.swipe-hint.again') };
    let drag = null;
    const setDrag = (dx) => {
      swipe.style.transform = dx ? `translateX(${dx}px) rotate(${dx / 28}deg)` : '';
      hints.good.style.opacity = revealed ? Math.max(0, Math.min(1, dx / 110)) : 0;
      hints.again.style.opacity = revealed ? Math.max(0, Math.min(1, -dx / 110)) : 0;
    };
    swipe.addEventListener('pointerdown', (e) => {
      if (busy || (e.pointerType === 'mouse' && e.button !== 0)) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, moving: false };
    });
    swipe.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const mx = e.clientX - drag.x;
      const my = e.clientY - drag.y;
      if (!drag.moving) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        if (Math.abs(my) > Math.abs(mx)) { drag = null; return; } // senkrecht: Seite scrollen
        drag.moving = true;
        swipe.setPointerCapture(e.pointerId);
        swipe.classList.remove('animating', 'enter');
      }
      drag.dx = revealed ? mx : mx * 0.2; // vor dem Umdrehen nur leicht nachgeben
      setDrag(drag.dx);
    });
    const release = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { moving, dx } = drag;
      drag = null;
      if (!moving) {
        if (e.type === 'pointerup' && !e.target.closest('a')) toggleFlip();
        return;
      }
      if (revealed && Math.abs(dx) > Math.min(140, swipe.offsetWidth * 0.25)) {
        answer(dx > 0);
      } else {
        swipe.classList.add('animating');
        setDrag(0);
      }
    };
    swipe.addEventListener('pointerup', release);
    swipe.addEventListener('pointercancel', release);
  }

  function answer(knew) {
    if (busy || !revealed) return;
    busy = true;
    const card = queue[0];
    recordAnswer(deck.id, card, knew);
    haptic(knew ? 15 : [8, 50, 8]);
    const swipe = app.querySelector('#swipe');
    const next = () => {
      queue.shift();
      if (knew) knewCount += 1;
      else {
        repeatCount += 1;
        queue.splice(Math.min(queue.length, 4), 0, card); // kommt in dieser Runde bald wieder
      }
      show();
    };
    if (REDUCED_MOTION || !swipe) return next();
    const dir = knew ? 1 : -1;
    swipe.classList.add('animating');
    swipe.style.transform = `translateX(${dir * Math.max(window.innerWidth, 600)}px) rotate(${dir * 14}deg)`;
    swipe.style.opacity = '0';
    const bar = app.querySelector('.study-progress span');
    if (bar && knew) bar.style.width = `${pct(knewCount + 1, initial)}%`;
    setTimeout(next, 260);
  }

  keyHandler = (e) => {
    if (queue.length === 0 || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.('select, input, textarea')) return;
    if (e.key === 'm' || e.key === 'M') app.querySelector('#mark')?.click();
    else if (e.key === ' ' || (e.key === 'Enter' && !e.target.closest?.('button, a'))) {
      e.preventDefault();
      if (!revealed) app.querySelector('#reveal')?.click();
      else app.querySelector('#flip')?.classList.toggle('flipped');
    } else if (revealed && (e.key === '1' || e.key === '2')) answer(e.key === '2');
  };
  document.addEventListener('keydown', keyHandler);
  show();
}

function viewStats() {
  const log = combinedLog();
  const days = 7 * 20;
  const start = Date.now() - (days - 1) * DAY;
  const cells = [];
  for (let i = 0; i < days; i++) {
    const k = todayKey(start + i * DAY);
    const n = log[k]?.reviews || 0;
    const lvl = n === 0 ? '' : n < 10 ? 'l1' : n < 30 ? 'l2' : n < 60 ? 'l3' : 'l4';
    cells.push(`<div class="${lvl}" title="${k}: ${n} Karten"></div>`);
  }
  let rev30 = 0, cor30 = 0;
  for (let i = 0; i < 30; i++) {
    const l = log[todayKey(Date.now() - i * DAY)];
    if (l) { rev30 += l.reviews; cor30 += l.correct; }
  }

  app.innerHTML = `
    <div class="page-head">
      <h1>Fortschritt</h1>
      <p>Deine Lernaktivität und der Stand pro Modul.</p>
    </div>
    <div class="tiles">
      ${tile('flame', 'Tage Serie', streak(), { cls: 'flame' })}
      ${tile('repeat', 'Antworten · 30 Tage', rev30)}
      ${tile('check', '„Kann ich“ · 30 Tage', pct(cor30, rev30), { suffix: ' %' })}
    </div>
    <h2>Aktivität · 20 Wochen</h2>
    <div class="panel"><div class="heatmap">${cells.join('')}</div></div>
    <h2>Pro Modul</h2>
    <div class="grid">
      ${DECKS.map((d) => {
        const s = deckStats(d);
        return `<div class="panel deck" style="--deck:${d.color}">
          <div class="deck-head">
            <div class="deck-icon">${deckInitials(d.name)}</div>
            <div><h3>${esc(d.name)}</h3><div class="sub">${s.total} Karten</div></div>
            <div class="deck-pct">${pct(s.mastered, s.total)} %<small>gekonnt</small></div>
          </div>
          ${progressBar(s)}
          <div class="deck-meta"><span>${s.new} neu</span><span>${s.learning} wiederholen</span><span>${s.mastered} gekonnt</span><span class="star">${icon('star', 'fill')}${s.marked}</span></div>
          ${topicsOf(d).length ? `<details class="small"><summary>Nach Thema</summary>
            <table class="topic-table">${topicsOf(d).map((t) => {
              const ts = deckStats(d, t);
              return `<tr><td>${esc(t)}</td><td>${ts.mastered}/${ts.total} · ${pct(ts.mastered, ts.total)} %</td></tr>`;
            }).join('')}</table></details>` : ''}
        </div>`;
      }).join('')}
    </div>
    ${legend()}
  `;
  countUp(app);
}

function deletedCards() {
  return DECKS.flatMap((deck) => deck.cards
    .filter((c) => stateOf(deck.id, c.id)?.deleted)
    .map((card) => ({ deck, card })));
}

function viewSettings() {
  const sync = !!syncTarget();
  app.innerHTML = `
    <div class="page-head">
      <h1>${ACCOUNTS ? 'Konto' : 'Einstellungen'}</h1>
      <p>${ACCOUNTS ? 'Login, Synchronisierung und Sicherung.' : 'Synchronisierung und Sicherung.'}</p>
    </div>

    ${ACCOUNTS ? `
    <div class="panel stack">
      <div class="account-head">
        <span class="avatar">${esc(session.name.charAt(0).toUpperCase())}</span>
        <div><b>${esc(session.name)}</b><div class="small muted">Dein Fortschritt wird automatisch gespeichert und ist auf jedem Gerät verfügbar, auf dem du dich anmeldest.</div></div>
      </div>
      <p class="small muted" id="syncInfo">${esc(syncStatusText())}</p>
      <div class="toolbar">
        <button class="primary" id="syncNow">${icon('cloud')}Jetzt synchronisieren</button>
        <button id="logout">${icon('logout')}Abmelden</button>
      </div>
    </div>` : `
    <h2>Synchronisierung zwischen Geräten</h2>
    <div class="panel stack">
      ${sync ? `
        <p>Aktiv – der Fortschritt wird in einem privaten GitHub Gist gespeichert und nach dem Lernen automatisch abgeglichen.</p>
        <p class="small muted" id="syncInfo">${esc(syncStatusText())}</p>
        <div class="toolbar">
          <button class="primary" id="syncNow">${icon('cloud')}Jetzt synchronisieren</button>
          <button id="syncOff">Sync auf diesem Gerät beenden</button>
        </div>`
      : `
        <p class="small muted">Einmal pro Gerät einrichten: Erstelle auf GitHub einen
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Fine-grained Token</a>
          mit der Berechtigung <b>Account permissions → Gists: Read and write</b> (sonst nichts) und füge ihn hier ein.
          Auf allen Geräten denselben Token (oder je Gerät einen eigenen) verwenden – der Fortschritt landet im selben privaten Gist.</p>
        <div class="toolbar">
          <input type="password" id="token" class="text-input" placeholder="github_pat_…" autocomplete="off">
          <button class="primary" id="syncOn">Verbinden</button>
        </div>`}
    </div>`}

    <h2>Gelöschte Karten</h2>
    <div class="panel">
      ${deletedCards().length === 0 ? '<p class="small muted" style="margin:0">Keine gelöschten Karten.</p>'
        : deletedCards().map(({ deck, card }) => `<div class="deleted-row">
          <span><span class="small muted">${esc(deck.name)} · </span>${esc(card.front.split('\n')[0])}</span>
          <button class="small" data-restore="${esc(deck.id)}/${esc(card.id)}">${icon('undo')}Wiederherstellen</button>
        </div>`).join('')}
    </div>

    <h2>Sicherung</h2>
    <div class="panel stack">
      <p class="small muted">Fortschritt${ACCOUNTS ? ' deines Logins' : ''} als Datei sichern oder wiederherstellen.${sync ? ' Import und Zurücksetzen gelten wegen der Synchronisierung für alle Geräte.' : ''}</p>
      <div class="toolbar">
        <button id="export">${icon('download')}Exportieren</button>
        <label class="btn">${icon('upload')}Importieren<input type="file" id="import" accept="application/json" hidden></label>
        <button id="reset" class="danger-outline">${icon('trash')}Zurücksetzen</button>
      </div>
    </div>
    <p class="small muted" id="msg"></p>
  `;
  const msg = app.querySelector('#msg');
  const say = (text) => { msg.textContent = text; };

  app.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => {
    const [deckId, cardId] = b.dataset.restore.split('/');
    setDeleted(deckId, cardId, false);
    viewSettings();
    app.querySelector('#msg').textContent = 'Karte wiederhergestellt.';
  }));

  app.querySelector('#syncOn')?.addEventListener('click', async () => {
    const token = app.querySelector('#token').value.trim();
    if (!token) return say('Bitte zuerst einen Token einfügen.');
    say('Verbinde …');
    try {
      await connectSync(token);
      viewSettings();
      app.querySelector('#msg').textContent = 'Verbunden und synchronisiert.';
    } catch (err) {
      say(`Verbindung fehlgeschlagen: ${err.message}`);
    }
  });
  app.querySelector('#syncNow')?.addEventListener('click', async () => {
    say('Synchronisiere …');
    await runSync();
    say(syncState.error ? `Fehler: ${syncState.error}` : 'Synchronisiert.');
    const info = app.querySelector('#syncInfo');
    if (info) info.textContent = syncStatusText();
  });
  app.querySelector('#logout')?.addEventListener('click', logout);
  app.querySelector('#syncOff')?.addEventListener('click', () => {
    if (!confirm('Sync auf diesem Gerät beenden? Der Fortschritt bleibt hier und im Gist erhalten.')) return;
    setSyncConfig(null);
    viewSettings();
  });

  app.querySelector('#export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(progress, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `karteikarten-fortschritt-${todayKey()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  app.querySelector('#import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data.cards || !data.log) throw new Error('Unbekanntes Format');
      progress = { ...defaultProgress(), ...data };
      saveProgress();
      if (syncTarget()) await runSync({ overwrite: true });
      say('Fortschritt importiert.');
    } catch (err) {
      say(`Import fehlgeschlagen: ${err.message}`);
    }
  });
  app.querySelector('#reset').addEventListener('click', async () => {
    if (!confirm(`Wirklich den gesamten Lernfortschritt löschen?${syncTarget() ? ' Das gilt für alle synchronisierten Geräte.' : ''}`)) return;
    progress = defaultProgress();
    saveProgress();
    if (syncTarget()) await runSync({ overwrite: true });
    say('Fortschritt zurückgesetzt.');
  });
}

function hasProgress(p) {
  return ['cards', 'log', 'logs'].some((k) => Object.keys(p[k] || {}).length > 0);
}

function viewLogin() {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="panel login">
        <img class="login-logo" src="icons/icon.svg" alt="">
        <h1>Karteikarten</h1>
        <p class="lead">Melde dich mit deinem Login-Code an.</p>
        <form id="loginForm">
          <div class="input-icon">${icon('key')}<input id="code" class="text-input" placeholder="Login-Code" aria-label="Login-Code" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
          <button class="primary">Anmelden</button>
        </form>
        <p class="login-msg" id="loginMsg"></p>
        <p class="note">Zugänge vergibt der Admin.</p>
      </div>
    </div>`;
  const msg = app.querySelector('#loginMsg');
  const input = app.querySelector('#code');
  input.focus();
  app.querySelector('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = normalizeCode(input.value);
    if (!code) return;
    msg.textContent = 'Prüfe …';
    msg.className = 'login-msg muted';
    try {
      const account = await rpc('kk_login', { p_code: code });
      if (!account) {
        msg.textContent = 'Unbekannter Login-Code.';
        msg.className = 'login-msg error';
        return;
      }
      await completeLogin(code, account);
    } catch (err) {
      msg.textContent = `Anmeldung fehlgeschlagen: ${err.message}`;
      msg.className = 'login-msg error';
    }
  });
}

async function completeLogin(code, account) {
  setSession({ code, name: account.name });
  progress = loadProgress();
  const legacy = loadProgress(STORAGE_KEY);
  let alreadyMigrated = false;
  try { alreadyMigrated = !!localStorage.getItem(MIGRATED_KEY); } catch { /* ignorieren */ }
  // Fortschritt aus der Zeit ohne Login anbieten – nur für Konten, die noch leer sind
  if (!alreadyMigrated && hasProgress(legacy) && !hasProgress(account.progress || {}) && !hasProgress(progress)) {
    const take = await askMigration(account.name, Object.keys(legacy.cards).length);
    if (take) await migrateLegacy(legacy);
  }
  await runSync();
  location.hash = '#/';
  route();
}

function askMigration(name, count) {
  return new Promise((resolve) => {
    app.innerHTML = `
      <div class="login-wrap">
        <div class="panel login">
          <img class="login-logo" src="icons/icon.svg" alt="">
          <h1>Fortschritt übernehmen?</h1>
          <p class="lead">Auf diesem Gerät gibt es Fortschritt aus der Zeit ohne Login (${count} Karten bearbeitet).</p>
          <p class="note">Übernimm ihn nur, wenn es <b>deiner</b> ist – er wird dann dem Login <b>${esc(name)}</b> zugeordnet.</p>
          <div class="actions">
            <button class="primary" id="take">Übernehmen</button>
            <button id="skip">Nicht übernehmen</button>
          </div>
        </div>
      </div>`;
    app.querySelector('#take').addEventListener('click', () => resolve(true));
    app.querySelector('#skip').addEventListener('click', () => resolve(false));
  });
}

async function migrateLegacy(legacy) {
  let merged = legacy;
  // War die Gist-Synchronisierung aktiv, auch den Stand der anderen Geräte mitnehmen
  const cfg = syncConfig();
  if (cfg) {
    try {
      const remote = await readGist(cfg.token, cfg.gistId);
      if (remote) merged = mergeRemote(legacy, remote);
    } catch (e) {
      console.warn('Gist konnte nicht gelesen werden', e);
    }
  }
  progress = { ...defaultProgress(), ...merged };
  saveProgress();
  try { localStorage.setItem(MIGRATED_KEY, session.code); } catch { /* ignorieren */ }
}

async function logout() {
  if (syncTimer) await runSync();
  setSession(null);
  progress = loadProgress();
  renderSyncBadge();
  route();
}

function viewNotFound() {
  app.innerHTML = '<p>Seite nicht gefunden. <a href="#/">Zur Übersicht</a></p>';
}

// ---------- Synchronisierung über einen privaten GitHub Gist ----------
//
// Jedes Gerät hält seinen Fortschritt lokal. Beim Sync wird der Gist geladen, mit dem lokalen
// Stand zusammengeführt (pro Karte gewinnt die zuletzt gelernte Version, Lernstatistik pro Gerät)
// und das Ergebnis wieder hochgeladen.

const SYNC_KEY = 'karteikarten-sync-v1';
const DEVICE_KEY = 'karteikarten-device-id';
const GIST_FILE = 'karteikarten-fortschritt.json';
const syncState = { running: null, last: 0, error: '' };
let syncTimer = null;

function syncConfig() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)); } catch { return null; }
}

function setSyncConfig(cfg) {
  try {
    if (cfg) localStorage.setItem(SYNC_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(SYNC_KEY);
  } catch (e) { console.warn(e); }
  renderSyncBadge();
}

function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch { return 'unbekannt'; }
}

async function gh(token, path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 401) throw new Error('Token ungültig oder abgelaufen');
  if (res.status === 403 || res.status === 404) throw new Error('Kein Zugriff – hat der Token die Berechtigung „Gists: Read and write“?');
  if (!res.ok) throw new Error(`GitHub antwortet mit HTTP ${res.status}`);
  return res.json();
}

function toRemote(p) {
  return {
    version: 1,
    updated: new Date().toISOString(),
    epoch: p.epoch || 0,
    cards: p.cards,
    logs: { ...p.otherLogs, [deviceId()]: p.log },
    newIntroduced: p.newIntroduced,
    settings: p.settings,
  };
}

function mergeRemote(local, remote) {
  const me = deviceId();
  // Auf einem anderen Gerät wurde importiert/zurückgesetzt: dessen Stand gilt, der lokale wird verworfen
  if ((remote.epoch || 0) > (local.epoch || 0)) {
    const { [me]: ownLog = {}, ...otherLogs } = remote.logs || {};
    return {
      ...defaultProgress(),
      cards: remote.cards || {},
      log: ownLog,
      otherLogs,
      newIntroduced: remote.newIntroduced || {},
      settings: { ...defaultProgress().settings, ...(remote.settings || {}) },
      epoch: remote.epoch,
    };
  }
  const cards = { ...remote.cards };
  for (const [k, st] of Object.entries(local.cards)) {
    if (!cards[k] || (st.last || 0) >= (cards[k].last || 0)) cards[k] = st;
  }
  const newIntroduced = JSON.parse(JSON.stringify(remote.newIntroduced || {}));
  for (const [day, decks] of Object.entries(local.newIntroduced)) {
    const d = newIntroduced[day] || (newIntroduced[day] = {});
    for (const [deck, n] of Object.entries(decks)) d[deck] = Math.max(d[deck] || 0, n);
  }
  const otherLogs = { ...(remote.logs || {}) };
  delete otherLogs[me];
  const remoteSettings = remote.settings || {};
  const settings = (remoteSettings.updatedAt || 0) > (local.settings.updatedAt || 0)
    ? { ...local.settings, ...remoteSettings } : local.settings;
  return { ...local, cards, newIntroduced, otherLogs, settings };
}

async function findOrCreateGist(token) {
  for (let page = 1; page <= 10; page++) {
    const gists = await gh(token, `/gists?per_page=100&page=${page}`);
    const hit = gists.find((g) => g.files && g.files[GIST_FILE]);
    if (hit) return hit.id;
    if (gists.length < 100) break;
  }
  const created = await gh(token, '/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: 'Karteikarten – Lernfortschritt (automatisch synchronisiert)',
      public: false,
      files: { [GIST_FILE]: { content: JSON.stringify(toRemote(progress)) } },
    }),
  });
  return created.id;
}

async function readGist(token, gistId) {
  const gist = await gh(token, `/gists/${gistId}`);
  const file = gist.files[GIST_FILE];
  if (!file) return null;
  if (file.truncated) {
    const res = await fetch(file.raw_url, { cache: 'no-store' });
    return res.json();
  }
  return JSON.parse(file.content);
}

async function connectSync(token) {
  const gistId = await findOrCreateGist(token);
  setSyncConfig({ token, gistId });
  await runSync();
  if (syncState.error) throw new Error(syncState.error);
}

// Wohin synchronisiert wird: mit Logins auf den Server (pro Login), sonst in den Gist
function syncTarget() {
  if (ACCOUNTS) {
    if (!session) return null;
    const code = session.code;
    return {
      read: async () => {
        const account = await rpc('kk_login', { p_code: code });
        if (!account) throw Object.assign(new Error('Login existiert nicht mehr'), { noAccount: true });
        return hasProgress(account.progress || {}) ? account.progress : null;
      },
      write: async (data) => {
        const ok = await rpc('kk_save', { p_code: code, p_progress: data });
        if (!ok) throw Object.assign(new Error('Login existiert nicht mehr'), { noAccount: true });
      },
    };
  }
  const cfg = syncConfig();
  if (!cfg) return null;
  return {
    read: () => readGist(cfg.token, cfg.gistId),
    write: (data) => gh(cfg.token, `/gists/${cfg.gistId}`, {
      method: 'PATCH',
      body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(data) } } }),
    }),
  };
}

// overwrite: lokalen Stand ohne Zusammenführen hochladen (nach Import/Zurücksetzen)
function runSync({ overwrite = false } = {}) {
  const target = syncTarget();
  if (!target) return Promise.resolve(false);
  if (syncState.running) return syncState.running.then(() => runSync({ overwrite }));
  clearTimeout(syncTimer);
  syncTimer = null;
  syncState.running = (async () => {
    renderSyncBadge('läuft');
    const before = JSON.stringify(progress);
    try {
      if (!overwrite) {
        const remote = await target.read();
        if (remote) progress = mergeRemote(progress, remote);
      } else {
        progress.otherLogs = {};
        progress.epoch = Date.now();
      }
      saveProgress();
      await target.write(toRemote(progress));
      syncState.last = Date.now();
      syncState.error = '';
    } catch (e) {
      console.warn('Sync fehlgeschlagen', e);
      syncState.error = e.message;
      // Der Admin hat den Login entfernt: abmelden
      if (e.noAccount) setTimeout(() => { setSession(null); route(); });
    } finally {
      syncState.running = null;
      renderSyncBadge();
    }
    return JSON.stringify(progress) !== before;
  })();
  return syncState.running;
}

// nach dem Lernen gebündelt synchronisieren statt nach jeder Karte
function scheduleSync() {
  if (!syncTarget()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 5000);
}

function syncStatusText() {
  if (syncState.error) return `Letzter Sync fehlgeschlagen: ${syncState.error}`;
  if (!syncState.last) return 'Noch nicht synchronisiert.';
  return `Zuletzt synchronisiert um ${new Date(syncState.last).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}.`;
}

function renderSyncBadge(state) {
  const el = document.getElementById('sync-badge');
  if (!el) return;
  if (!syncTarget()) { el.textContent = ''; return; }
  el.innerHTML = state === 'läuft' ? `${icon('cloud')}Sync …`
    : syncState.error ? `${icon('alert')}Sync-Fehler`
    : syncState.last ? `${icon('cloud')}Synchron` : '';
  el.title = syncStatusText();
  el.style.color = syncState.error ? 'var(--again)' : '';
}

// Nach einem Sync mit neuen Daten neu zeichnen – aber nie mitten in einer Lernrunde
async function syncAndRefresh() {
  const changed = await runSync();
  if (changed && !location.hash.startsWith('#/lernen/') && !location.hash.startsWith('#/einstellungen')) route();
}

document.addEventListener('visibilitychange', () => {
  if (!syncTarget()) return;
  if (document.visibilityState === 'hidden') { if (syncTimer) runSync(); }
  else syncAndRefresh();
});

// ---------- Neue Version erkennen ----------
// Eine installierte App wird beim Zurückwechseln nicht neu geladen. Deshalb prüfen, ob sich App-Dateien
// oder Karten geändert haben, und dann neu laden (nicht mitten in einer Lernrunde).

const VERSION_CHECK_INTERVAL = 2 * 60 * 1000;
let loadedVersion = null;
let lastVersionCheck = 0;

async function currentVersion() {
  const files = ['index.html', 'app.js', 'config.js', 'style.css', 'decks/index.json', ...DECKS.map((d) => `decks/${d.id}.json`)];
  const texts = await Promise.all(files.map((f) => fetch(f, { cache: 'no-cache' }).then((r) => (r.ok ? r.text() : ''))));
  let h = 5381; // djb2
  for (const t of texts) for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return h;
}

async function checkForUpdate() {
  if (loadedVersion === null || Date.now() - lastVersionCheck < VERSION_CHECK_INTERVAL) return;
  if (location.hash.startsWith('#/lernen/')) return;
  lastVersionCheck = Date.now();
  try {
    if ((await currentVersion()) !== loadedVersion) {
      if (syncTimer) await runSync();
      location.reload();
    }
  } catch { /* offline: nichts tun */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkForUpdate();
});

// ---------- Router ----------

const TABS = [
  { href: '#/', icon: 'home', label: 'Übersicht', match: (p) => !p[0] || p[0] === 'deck' },
  { href: '#/statistik', icon: 'chart', label: 'Fortschritt', match: (p) => p[0] === 'statistik' },
  { href: '#/einstellungen', icon: ACCOUNTS ? 'user' : 'settings', label: ACCOUNTS ? 'Konto' : 'Einstellungen', match: (p) => p[0] === 'einstellungen' },
];

function renderTabbar(parts) {
  const nav = document.getElementById('tabbar');
  if (!nav) return;
  nav.innerHTML = TABS.map((t) => `<a href="${t.href}" class="${t.match(parts) ? 'active' : ''}"${t.match(parts) ? ' aria-current="page"' : ''}>${icon(t.icon)}<span>${t.label}</span></a>`).join('');
}

function route() {
  if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  const parts = path.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  const view = ACCOUNTS && !session ? 'login' : parts[0] === 'lernen' ? 'study' : 'page';
  document.body.dataset.view = view;
  renderTabbar(parts);
  // Seitenübergang neu starten
  app.classList.remove('page');
  void app.offsetWidth;
  app.classList.add('page');
  if (view === 'login') return viewLogin();
  if (parts.length === 0) return viewOverview();
  if (parts[0] === 'deck' && parts[1]) return viewDeck(parts[1]);
  if (parts[0] === 'lernen' && parts[1]) return viewStudy(parts[1]);
  if (parts[0] === 'statistik') return viewStats();
  if (parts[0] === 'einstellungen') return viewSettings();
  return viewNotFound();
}

window.addEventListener('hashchange', route);
renderUserBadge();

loadDecks()
  .then(() => {
    route();
    syncAndRefresh();
    lastVersionCheck = Date.now();
    currentVersion().then((v) => { loadedVersion = v; }).catch(() => {});
  })
  .catch((e) => {
    app.innerHTML = `<div class="panel"><p><b>Karten konnten nicht geladen werden.</b></p>
      <p class="small muted">${esc(e.message)}</p>
      <p class="small">Die App muss über einen Webserver geöffnet werden (z.&nbsp;B. GitHub Pages oder <code>python3 -m http.server</code>), nicht direkt als Datei.</p></div>`;
  });

// Offline-Fähigkeit und Installierbarkeit als App
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker nicht registriert', e));
}

// KaTeX wird per defer geladen und ist evtl. erst nach dem ersten Rendern verfügbar
window.addEventListener('load', () => renderMath(app));
