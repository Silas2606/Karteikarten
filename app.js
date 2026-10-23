'use strict';

// ---------- Konstanten & Speicher ----------

const STORAGE_KEY = 'karteikarten-progress-v1';
const DAY = 24 * 60 * 60 * 1000;

const app = document.getElementById('app');
let DECKS = []; // [{id, name, prefix, color, cards: [...]}]

function defaultProgress() {
  // log: Lernstatistik dieses Geräts, otherLogs: die der anderen Geräte (per Sync)
  return { version: 1, cards: {}, log: {}, otherLogs: {}, newIntroduced: {}, settings: { updatedAt: 0 } };
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
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
        : 'Bitte bestätige ein zweites Mal. Die Löschung gilt auch auf deinen anderen Geräten. Wiederherstellen kannst du sie nur noch unter Einstellungen → Gelöschte Karten.'}</p>
      <div class="toolbar" style="justify-content:flex-end;margin:0">
        <button id="cancel">Abbrechen</button>
        <button class="danger" id="confirm">${n === 1 ? 'Löschen' : 'Endgültig löschen'}</button>
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
  const blocks = s.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-•]\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${l.replace(/^\s*[-•]\s+/, '')}</li>`).join('')}</ul>`;
    }
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      return `<ol>${lines.map((l) => `<li>${l.replace(/^\s*\d+[.)]\s+/, '')}</li>`).join('')}</ol>`;
    }
    return `<p>${lines.join('<br>')}</p>`;
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

function linkBtn(href, label, { primary = false, disabled = false } = {}) {
  return `<a class="btn${primary ? ' primary' : ''}" href="${href}"${disabled ? ' aria-disabled="true" style="opacity:.45;pointer-events:none"' : ''}>${label}</a>`;
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

// ---------- Seiten ----------

function viewOverview() {
  const today = combinedLog()[todayKey()] || { reviews: 0 };
  const totals = DECKS.reduce((acc, d) => {
    const s = deckStats(d);
    for (const k in s) acc[k] = (acc[k] || 0) + s[k];
    return acc;
  }, {});

  app.innerHTML = `
    <h1>Deine Module</h1>
    <div class="panel stats" style="margin-bottom:18px">
      <div class="stat"><b>${totals.open || 0}</b><span>offen</span></div>
      <div class="stat"><b>${today.reviews}</b><span>heute gelernt</span></div>
      <div class="stat"><b>${streak()}</b><span>Tage Serie</span></div>
      <div class="stat"><b>${totals.mastered || 0} / ${totals.total || 0}</b><span>Karten gekonnt</span></div>
    </div>
    <div class="grid">
      ${DECKS.map((d) => {
        const s = deckStats(d);
        return `<div class="panel deck" style="--deck:${d.color}">
          <h3>${esc(d.name)}</h3>
          ${d.error ? `<p class="small" style="color:var(--again)">Fehler beim Laden: ${esc(d.error)}</p>` : ''}
          ${s.total === 0
            ? '<p class="muted small">Noch keine Karten. Lade ein Dokument bei Claude hoch, um Karten zu erzeugen.</p>'
            : `<div class="small muted">${s.total} Karten · ${s.open} offen · ${s.mastered} gekonnt${s.marked ? ` · ★ ${s.marked}` : ''}</div>${progressBar(s)}`}
          <div class="actions">
            ${linkBtn(studyHref(d.id), `Lernen${s.open ? ` (${s.open})` : ''}`, { primary: true, disabled: !s.open })}
            ${linkBtn(`#/deck/${d.id}`, 'Karten')}
          </div>
        </div>`;
      }).join('')}
    </div>
    <p style="margin-top:14px">${legend()}</p>
  `;
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
    <h1>${esc(deck.name)}</h1>
    <div class="toolbar">
      <label>Thema:
        <select id="topic">
          <option value="">Alle Themen</option>
          ${topics.map((t) => `<option ${t === topic ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="panel" style="display:flex;flex-direction:column;gap:12px">
      <div class="stats">
        <div class="stat"><b>${s.total}</b><span>Karten</span></div>
        <div class="stat"><b>${s.open}</b><span>offen</span></div>
        <div class="stat"><b>${s.mastered}</b><span>gekonnt</span></div>
        <div class="stat"><b>${s.marked}</b><span>markiert</span></div>
      </div>
      ${progressBar(s)}
      <div class="toolbar" style="margin:0">
        ${linkBtn(studyHref(deck.id, topic), `Offene lernen (${s.open})`, { primary: true, disabled: !s.open })}
        ${linkBtn(studyHref(deck.id, topic, 'alle'), `Alle Karten lernen (${s.total})`, { disabled: !s.total })}
        ${linkBtn(studyHref(deck.id, topic, 'markiert'), `★ Markierte lernen (${s.marked})`, { disabled: !s.marked })}
      </div>
    </div>
    <div class="toolbar" style="margin:28px 0 12px;justify-content:space-between">
      <h2 style="margin:0">Karten</h2>
      <select id="filter">
        ${Object.entries(FILTERS).map(([k, v]) => `<option value="${k}" ${k === filter ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </div>
    <div class="card-list">
      ${cards.length === 0 ? '<p class="muted">Keine Karten vorhanden.</p>' : cards.map((c) => {
        const st = stateOf(deck.id, c.id);
        const stat = status(st);
        return `<details data-id="${esc(c.id)}">
          <summary><span>${st?.marked ? '<span class="star">★</span> ' : ''}${esc(c.front.split('\n')[0])}</span><span class="pill ${stat}">${STATUS_LABEL[stat]}</span></summary>
          <div class="content">${md(c.back)}
            <p class="small muted" style="margin-top:8px">${esc([c.topic, c.source].filter(Boolean).join(' · '))}</p>
            <div class="toolbar" style="margin:8px 0 0">
              <button class="small" data-action="mark">${st?.marked ? 'Markierung entfernen' : '☆ Markieren'}</button>
              ${isKnown(st) ? '<button class="small" data-action="relearn">Wieder in den Zyklus</button>' : ''}
              <button class="small danger-outline" data-action="delete">🗑 Löschen</button>
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
  let knewCount = 0;
  let repeatCount = 0;
  let revealed = false;

  const backHref = `#/deck/${deck.id}${topic ? `?thema=${encodeURIComponent(topic)}` : ''}`;

  function finish() {
    const s = deckStats(deck, topic);
    app.innerHTML = `<div class="panel done">
      <h1>${knewCount + repeatCount ? 'Runde geschafft! 🎉' : 'Nichts zu lernen'}</h1>
      <p class="muted">${knewCount + repeatCount
        ? `${knewCount} Karten gekonnt, ${repeatCount}× wiederholt.`
        : mode === 'markiert' ? 'Keine markierten Karten.' : 'Alle Karten sind als „Kann ich“ markiert.'}</p>
      <p class="muted small">${s.mastered} von ${s.total} Karten gekonnt${topic ? ` (${esc(topic)})` : ''}.</p>
      <p class="toolbar" style="justify-content:center">
        ${s.total ? linkBtn(studyHref(deck.id, topic, 'alle'), 'Alle Karten lernen') : ''}
        ${linkBtn(backHref, 'Zum Modul')}
        ${linkBtn('#/', 'Zur Übersicht', { primary: true })}
      </p>
    </div>`;
  }

  function show() {
    if (queue.length === 0) return finish();
    const card = queue[0];
    const st = stateOf(deck.id, card.id);
    app.innerHTML = `
      <div class="study-head">
        <a href="${backHref}">← ${esc(deck.name)}${topic ? ` · ${esc(topic)}` : ''}</a>
        <span class="muted small">${MODE_LABEL[mode] || ''} · noch ${queue.length} · ${knewCount} gekonnt</span>
      </div>
      <div class="card" style="border-top:4px solid ${deck.color}">
        <div class="card-top">
          <div class="topic">${esc(card.topic || '')}</div>
          <div class="card-actions">
            <button class="mark ${st?.marked ? 'on' : ''}" id="mark" title="Markieren (Taste M)">${st?.marked ? '★ Markiert' : '☆ Markieren'}</button>
            <button class="mark danger-outline" id="delete" title="Karte löschen" aria-label="Karte löschen">🗑</button>
          </div>
        </div>
        <div class="front">${md(card.front)}</div>
        ${revealed ? `<div class="back">${md(card.back)}</div>` : ''}
        ${revealed && card.source ? `<div class="source">Quelle: ${esc(card.source)}</div>` : ''}
      </div>
      ${revealed ? `
        <div class="answer-row">
          <button class="r-again" data-knew="0">Wiederholen</button>
          <button class="r-good" data-knew="1">Kann ich</button>
        </div>
        <p class="kbd-hint muted small">Tasten 1 / 2 · M = markieren</p>`
      : `<button class="primary reveal" id="reveal">Antwort zeigen</button>
         <p class="kbd-hint muted small">Leertaste · M = markieren</p>`}
    `;
    renderMath(app);
    app.querySelector('#reveal')?.addEventListener('click', () => { revealed = true; show(); });
    app.querySelector('#mark').addEventListener('click', mark);
    app.querySelector('#delete').addEventListener('click', () => confirmDelete(deck.id, card, () => {
      queue.shift(); // samt evtl. weiterer Vorkommen in der Runde entfernen
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === card.id) queue.splice(i, 1);
      revealed = false;
      show();
    }));
    app.querySelectorAll('[data-knew]').forEach((b) => b.addEventListener('click', () => answer(b.dataset.knew === '1')));
  }

  function mark() {
    toggleMark(deck.id, queue[0].id);
    show();
  }

  function answer(knew) {
    const card = queue.shift();
    recordAnswer(deck.id, card, knew);
    if (knew) knewCount += 1;
    else {
      repeatCount += 1;
      queue.splice(Math.min(queue.length, 4), 0, card); // kommt in dieser Runde bald wieder
    }
    revealed = false;
    show();
  }

  keyHandler = (e) => {
    if (queue.length === 0 || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'm' || e.key === 'M') mark();
    else if (!revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); revealed = true; show(); }
    else if (revealed && (e.key === '1' || e.key === '2')) answer(e.key === '2');
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
    <h1>Fortschritt</h1>
    <div class="panel stats">
      <div class="stat"><b>${streak()}</b><span>Tage Serie</span></div>
      <div class="stat"><b>${rev30}</b><span>Antworten (30 T)</span></div>
      <div class="stat"><b>${rev30 ? Math.round((cor30 / rev30) * 100) : '–'}%</b><span>„Kann ich“ (30 T)</span></div>
    </div>
    <h2>Aktivität (20 Wochen)</h2>
    <div class="panel"><div class="heatmap">${cells.join('')}</div></div>
    <h2>Pro Modul</h2>
    <div class="grid">
      ${DECKS.map((d) => {
        const s = deckStats(d);
        const pct = s.total ? Math.round((s.mastered / s.total) * 100) : 0;
        return `<div class="panel deck" style="--deck:${d.color}">
          <h3>${esc(d.name)}</h3>
          <div class="small muted">${s.total} Karten · ${pct}% gekonnt</div>
          ${progressBar(s)}
          <div class="small">${s.new} neu · ${s.learning} wiederholen · ${s.mastered} gekonnt · ★ ${s.marked} markiert</div>
          ${topicsOf(d).length ? `<details class="small"><summary>Nach Thema</summary>
            <table style="width:100%;margin-top:6px">${topicsOf(d).map((t) => {
              const ts = deckStats(d, t);
              return `<tr><td>${esc(t)}</td><td style="text-align:right">${ts.mastered}/${ts.total}</td></tr>`;
            }).join('')}</table></details>` : ''}
        </div>`;
      }).join('')}
    </div>
    <p style="margin-top:14px">${legend()}</p>
  `;
}

function deletedCards() {
  return DECKS.flatMap((deck) => deck.cards
    .filter((c) => stateOf(deck.id, c.id)?.deleted)
    .map((card) => ({ deck, card })));
}

function viewSettings() {
  const sync = syncConfig();
  app.innerHTML = `
    <h1>Einstellungen</h1>

    <h2>Synchronisierung zwischen Geräten</h2>
    <div class="panel" style="display:flex;flex-direction:column;gap:12px">
      ${sync ? `
        <p style="margin:0">Aktiv – der Fortschritt wird in einem privaten GitHub Gist gespeichert und nach dem Lernen automatisch abgeglichen.</p>
        <p class="small muted" style="margin:0" id="syncInfo">${esc(syncStatusText())}</p>
        <div class="toolbar" style="margin:0">
          <button class="primary" id="syncNow">Jetzt synchronisieren</button>
          <button id="syncOff">Sync auf diesem Gerät beenden</button>
        </div>`
      : `
        <p class="small muted" style="margin:0">Einmal pro Gerät einrichten: Erstelle auf GitHub einen
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Fine-grained Token</a>
          mit der Berechtigung <b>Account permissions → Gists: Read and write</b> (sonst nichts) und füge ihn hier ein.
          Auf allen Geräten denselben Token (oder je Gerät einen eigenen) verwenden – der Fortschritt landet im selben privaten Gist.</p>
        <div class="toolbar" style="margin:0">
          <input type="password" id="token" placeholder="github_pat_…" autocomplete="off"
            style="flex:1;min-width:200px;font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text)">
          <button class="primary" id="syncOn">Verbinden</button>
        </div>`}
    </div>

    <h2>Gelöschte Karten</h2>
    <div class="panel" style="display:flex;flex-direction:column;gap:10px">
      ${deletedCards().length === 0 ? '<p class="small muted" style="margin:0">Keine gelöschten Karten.</p>'
        : deletedCards().map(({ deck, card }) => `<div class="deleted-row">
          <span><span class="small muted">${esc(deck.name)} · </span>${esc(card.front.split('\n')[0])}</span>
          <button class="small" data-restore="${esc(deck.id)}/${esc(card.id)}">Wiederherstellen</button>
        </div>`).join('')}
    </div>

    <h2>Sicherung</h2>
    <div class="panel" style="display:flex;flex-direction:column;gap:12px">
      <p class="small muted" style="margin:0">Fortschritt als Datei sichern oder wiederherstellen.${sync ? ' Import und Zurücksetzen gelten wegen der Synchronisierung für alle Geräte.' : ''}</p>
      <div class="toolbar" style="margin:0">
        <button id="export">Fortschritt exportieren</button>
        <label class="btn">Fortschritt importieren<input type="file" id="import" accept="application/json" hidden></label>
        <button id="reset" style="color:var(--again)">Fortschritt zurücksetzen</button>
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
      if (syncConfig()) await runSync({ overwrite: true });
      say('Fortschritt importiert.');
    } catch (err) {
      say(`Import fehlgeschlagen: ${err.message}`);
    }
  });
  app.querySelector('#reset').addEventListener('click', async () => {
    if (!confirm(`Wirklich den gesamten Lernfortschritt löschen?${syncConfig() ? ' Das gilt für alle synchronisierten Geräte.' : ''}`)) return;
    progress = defaultProgress();
    saveProgress();
    if (syncConfig()) await runSync({ overwrite: true });
    say('Fortschritt zurückgesetzt.');
  });
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

// overwrite: lokalen Stand ohne Zusammenführen hochladen (nach Import/Zurücksetzen)
function runSync({ overwrite = false } = {}) {
  const cfg = syncConfig();
  if (!cfg) return Promise.resolve(false);
  if (syncState.running) return syncState.running.then(() => runSync({ overwrite }));
  clearTimeout(syncTimer);
  syncTimer = null;
  syncState.running = (async () => {
    renderSyncBadge('läuft');
    const before = JSON.stringify(progress);
    try {
      if (!overwrite) {
        const remote = await readGist(cfg.token, cfg.gistId);
        if (remote) progress = mergeRemote(progress, remote);
      } else {
        progress.otherLogs = {};
        progress.epoch = Date.now();
      }
      saveProgress();
      await gh(cfg.token, `/gists/${cfg.gistId}`, {
        method: 'PATCH',
        body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(toRemote(progress)) } } }),
      });
      syncState.last = Date.now();
      syncState.error = '';
    } catch (e) {
      console.warn('Sync fehlgeschlagen', e);
      syncState.error = e.message;
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
  if (!syncConfig()) return;
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
  if (!syncConfig()) { el.textContent = ''; return; }
  el.textContent = state === 'läuft' ? '⟳ Sync …' : syncState.error ? '⚠ Sync-Fehler' : syncState.last ? '✓ Synchron' : '';
  el.title = syncStatusText();
  el.style.color = syncState.error ? 'var(--again)' : 'var(--muted)';
}

// Nach einem Sync mit neuen Daten neu zeichnen – aber nie mitten in einer Lernrunde
async function syncAndRefresh() {
  const changed = await runSync();
  if (changed && !location.hash.startsWith('#/lernen/') && !location.hash.startsWith('#/einstellungen')) route();
}

document.addEventListener('visibilitychange', () => {
  if (!syncConfig()) return;
  if (document.visibilityState === 'hidden') { if (syncTimer) runSync(); }
  else syncAndRefresh();
});

// ---------- Router ----------

function route() {
  if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  const parts = path.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  if (parts.length === 0) return viewOverview();
  if (parts[0] === 'deck' && parts[1]) return viewDeck(parts[1]);
  if (parts[0] === 'lernen' && parts[1]) return viewStudy(parts[1]);
  if (parts[0] === 'statistik') return viewStats();
  if (parts[0] === 'einstellungen') return viewSettings();
  return viewNotFound();
}

window.addEventListener('hashchange', route);

loadDecks()
  .then(() => { route(); syncAndRefresh(); })
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
