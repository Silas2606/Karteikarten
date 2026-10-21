'use strict';

// ---------- Konstanten & Speicher ----------

const STORAGE_KEY = 'karteikarten-progress-v1';
const DAY = 24 * 60 * 60 * 1000;
const MASTERED_DAYS = 21; // ab diesem Intervall gilt eine Karte als "gefestigt"

const app = document.getElementById('app');
let DECKS = []; // [{id, name, prefix, color, cards: [...]}]

function defaultProgress() {
  return { version: 1, cards: {}, log: {}, newIntroduced: {}, settings: { newPerDay: 20 } };
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

function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function cardKey(deckId, cardId) { return `${deckId}/${cardId}`; }
function stateOf(deckId, cardId) { return progress.cards[cardKey(deckId, cardId)]; }

function status(st) {
  if (!st) return 'new';
  return st.interval >= MASTERED_DAYS ? 'mastered' : 'learning';
}
const STATUS_LABEL = { new: 'neu', learning: 'lernend', mastered: 'gefestigt' };

// ---------- Spaced Repetition (vereinfachtes SM-2) ----------

function schedule(st, rating) {
  const now = Date.now();
  const s = st ? { ...st } : { interval: 0, ease: 2.5, reps: 0, lapses: 0 };
  switch (rating) {
    case 'again':
      s.lapses += st ? 1 : 0;
      s.reps = 0;
      s.interval = 0;
      s.ease = Math.max(1.3, s.ease - 0.2);
      s.due = now + 10 * 60 * 1000;
      break;
    case 'hard':
      s.interval = Math.max(1, Math.round(s.interval * 1.2));
      s.ease = Math.max(1.3, s.ease - 0.15);
      s.reps += 1;
      s.due = now + s.interval * DAY;
      break;
    case 'good':
      s.interval = s.reps === 0 ? 1 : s.reps === 1 ? 3 : Math.round(s.interval * s.ease);
      s.reps += 1;
      s.due = now + s.interval * DAY;
      break;
    case 'easy':
      s.interval = s.reps === 0 ? 4 : Math.round(Math.max(s.interval, 1) * s.ease * 1.3);
      s.ease += 0.15;
      s.reps += 1;
      s.due = now + s.interval * DAY;
      break;
  }
  s.last = now;
  return s;
}

function intervalLabel(st, rating) {
  const s = schedule(st, rating);
  if (s.interval === 0) return '10 Min';
  if (s.interval < 31) return `${s.interval} T`;
  if (s.interval < 365) return `${Math.round(s.interval / 30)} Mon`;
  return `${(s.interval / 365).toFixed(1)} J`;
}

function recordReview(deckId, card, rating) {
  const key = cardKey(deckId, card.id);
  const wasNew = !progress.cards[key];
  progress.cards[key] = schedule(progress.cards[key], rating);
  const t = todayKey();
  const log = progress.log[t] || (progress.log[t] = { reviews: 0, correct: 0 });
  log.reviews += 1;
  if (rating !== 'again') log.correct += 1;
  if (wasNew) {
    const n = progress.newIntroduced[t] || (progress.newIntroduced[t] = {});
    n[deckId] = (n[deckId] || 0) + 1;
  }
  saveProgress();
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
  const now = Date.now();
  const r = { total: 0, new: 0, learning: 0, mastered: 0, due: 0 };
  for (const c of deck.cards) {
    if (topic && c.topic !== topic) continue;
    const st = stateOf(deck.id, c.id);
    r.total += 1;
    r[status(st)] += 1;
    if (st && st.due <= now) r.due += 1;
  }
  return r;
}

function newRemainingToday(deckId) {
  const used = (progress.newIntroduced[todayKey()] || {})[deckId] || 0;
  return Math.max(0, progress.settings.newPerDay - used);
}

function progressBar(s) {
  const pct = (n) => (s.total ? (n / s.total) * 100 : 0);
  return `<div class="bar" title="${s.mastered} gefestigt, ${s.learning} lernend, ${s.new} neu">
    <span class="mastered" style="width:${pct(s.mastered)}%"></span>
    <span class="learning" style="width:${pct(s.learning)}%"></span>
  </div>`;
}

function legend() {
  return `<div class="legend">
    <span><i style="background:var(--good)"></i>gefestigt</span>
    <span><i style="background:var(--hard)"></i>lernend</span>
    <span><i style="background:var(--border)"></i>neu</span>
  </div>`;
}

function topicsOf(deck) {
  return [...new Set(deck.cards.map((c) => c.topic).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
}

function streak() {
  let n = 0;
  let t = Date.now();
  if (!progress.log[todayKey(t)]) t -= DAY; // heute noch nicht gelernt: Serie zählt ab gestern
  while (progress.log[todayKey(t)]) { n += 1; t -= DAY; }
  return n;
}

// ---------- Seiten ----------

function viewOverview() {
  const today = progress.log[todayKey()] || { reviews: 0 };
  const totals = DECKS.reduce((acc, d) => {
    const s = deckStats(d);
    for (const k in s) acc[k] = (acc[k] || 0) + s[k];
    return acc;
  }, {});

  app.innerHTML = `
    <h1>Deine Module</h1>
    <div class="panel stats" style="margin-bottom:18px">
      <div class="stat"><b>${totals.due || 0}</b><span>heute fällig</span></div>
      <div class="stat"><b>${today.reviews}</b><span>heute gelernt</span></div>
      <div class="stat"><b>${streak()}</b><span>Tage Serie</span></div>
      <div class="stat"><b>${totals.mastered || 0} / ${totals.total || 0}</b><span>Karten gefestigt</span></div>
    </div>
    <div class="grid">
      ${DECKS.map((d) => {
        const s = deckStats(d);
        const startable = s.due + Math.min(s.new, newRemainingToday(d.id));
        return `<div class="panel deck" style="--deck:${d.color}">
          <h3>${esc(d.name)}</h3>
          ${d.error ? `<p class="small" style="color:var(--again)">Fehler beim Laden: ${esc(d.error)}</p>` : ''}
          ${s.total === 0
            ? '<p class="muted small">Noch keine Karten. Lade ein Dokument bei Claude hoch, um Karten zu erzeugen.</p>'
            : `<div class="small muted">${s.total} Karten · ${s.due} fällig · ${s.new} neu</div>${progressBar(s)}`}
          <div class="actions">
            <a class="btn primary" href="#/lernen/${d.id}" ${startable ? '' : 'aria-disabled="true" style="opacity:.45;pointer-events:none"'}>Lernen${startable ? ` (${startable})` : ''}</a>
            <a class="btn" href="#/deck/${d.id}">Karten</a>
          </div>
        </div>`;
      }).join('')}
    </div>
    <p style="margin-top:14px">${legend()}</p>
  `;
}

function viewDeck(deckId) {
  const deck = deckById(deckId);
  if (!deck) return viewNotFound();
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const topic = params.get('thema') || '';
  const topics = topicsOf(deck);
  const s = deckStats(deck, topic);
  const cards = deck.cards.filter((c) => !topic || c.topic === topic);
  const q = topic ? `?thema=${encodeURIComponent(topic)}` : '';
  const hard = cards.filter((c) => (stateOf(deck.id, c.id)?.lapses || 0) >= 2).length;

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
        <div class="stat"><b>${s.due}</b><span>fällig</span></div>
        <div class="stat"><b>${s.new}</b><span>neu</span></div>
        <div class="stat"><b>${s.learning}</b><span>lernend</span></div>
        <div class="stat"><b>${s.mastered}</b><span>gefestigt</span></div>
      </div>
      ${progressBar(s)}
      <div class="toolbar" style="margin:0">
        <a class="btn primary" href="#/lernen/${deck.id}${q}">Fällige lernen</a>
        <a class="btn" href="#/lernen/${deck.id}${q}${q ? '&' : '?'}modus=alle">Alle durchgehen</a>
        ${hard ? `<a class="btn" href="#/lernen/${deck.id}${q}${q ? '&' : '?'}modus=schwer">Schwierige (${hard})</a>` : ''}
      </div>
    </div>
    <h2>Karten</h2>
    <div class="card-list">
      ${cards.length === 0 ? '<p class="muted">Keine Karten vorhanden.</p>' : cards.map((c) => {
        const st = status(stateOf(deck.id, c.id));
        return `<details>
          <summary><span>${esc(c.front.split('\n')[0])}</span><span class="pill ${st}">${STATUS_LABEL[st]}</span></summary>
          <div class="content">${md(c.back)}
            <p class="small muted" style="margin-top:8px">${esc([c.topic, c.source].filter(Boolean).join(' · '))}</p>
          </div>
        </details>`;
      }).join('')}
    </div>
  `;
  app.querySelector('#topic').addEventListener('change', (e) => {
    location.hash = `#/deck/${deck.id}${e.target.value ? `?thema=${encodeURIComponent(e.target.value)}` : ''}`;
  });
  renderMath(app);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildQueue(deck, topic, mode) {
  const now = Date.now();
  const pool = deck.cards.filter((c) => !topic || c.topic === topic);
  if (mode === 'alle') return shuffle([...pool]);
  if (mode === 'schwer') return shuffle(pool.filter((c) => (stateOf(deck.id, c.id)?.lapses || 0) >= 2));
  const due = pool
    .filter((c) => { const st = stateOf(deck.id, c.id); return st && st.due <= now; })
    .sort((a, b) => stateOf(deck.id, a.id).due - stateOf(deck.id, b.id).due);
  const fresh = pool.filter((c) => !stateOf(deck.id, c.id)).slice(0, newRemainingToday(deck.id));
  // neue Karten zwischen die Wiederholungen mischen
  const queue = [...due];
  fresh.forEach((c, i) => queue.splice(Math.min(queue.length, i * 3 + 1), 0, c));
  return queue;
}

let keyHandler = null;

function viewStudy(deckId) {
  const deck = deckById(deckId);
  if (!deck) return viewNotFound();
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const topic = params.get('thema') || '';
  const mode = params.get('modus') || 'faellig';
  const queue = buildQueue(deck, topic, mode);
  const total = queue.length;
  let done = 0;
  let revealed = false;

  const backHref = `#/deck/${deck.id}${topic ? `?thema=${encodeURIComponent(topic)}` : ''}`;

  function finish() {
    app.innerHTML = `<div class="panel done">
      <h1>Geschafft! 🎉</h1>
      <p class="muted">${done ? `${done} Karten bearbeitet.` : 'Gerade ist nichts fällig.'} ${
        mode === 'faellig' ? 'Neue Wiederholungen werden automatisch fällig.' : ''}</p>
      <p><a class="btn primary" href="#/">Zur Übersicht</a> <a class="btn" href="${backHref}">Zum Modul</a></p>
    </div>`;
  }

  function show() {
    if (queue.length === 0) return finish();
    const card = queue[0];
    const st = stateOf(deck.id, card.id);
    app.innerHTML = `
      <div class="study-head">
        <a href="${backHref}">← ${esc(deck.name)}${topic ? ` · ${esc(topic)}` : ''}</a>
        <span class="muted small">${done} / ${total}${queue.length > total - done ? ' (+ Wiederholungen)' : ''} · ${STATUS_LABEL[status(st)]}</span>
      </div>
      <div class="card" style="border-top:4px solid ${deck.color}">
        ${card.topic ? `<div class="topic">${esc(card.topic)}</div>` : ''}
        <div class="front">${md(card.front)}</div>
        ${revealed ? `<div class="back">${md(card.back)}</div>` : ''}
        ${revealed && card.source ? `<div class="source">Quelle: ${esc(card.source)}</div>` : ''}
      </div>
      ${revealed ? `
        <div class="answer-row">
          <button class="r-again" data-r="again">Nochmal<small>${intervalLabel(st, 'again')}</small></button>
          <button class="r-hard" data-r="hard">Schwer<small>${intervalLabel(st, 'hard')}</small></button>
          <button class="r-good" data-r="good">Gut<small>${intervalLabel(st, 'good')}</small></button>
          <button class="r-easy" data-r="easy">Einfach<small>${intervalLabel(st, 'easy')}</small></button>
        </div>
        <p class="kbd-hint muted small">Tasten 1–4</p>`
      : `<button class="primary reveal" id="reveal">Antwort zeigen</button>
         <p class="kbd-hint muted small">Leertaste</p>`}
    `;
    renderMath(app);
    app.querySelector('#reveal')?.addEventListener('click', () => { revealed = true; show(); });
    app.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => rate(b.dataset.r)));
  }

  function rate(rating) {
    const card = queue.shift();
    recordReview(deck.id, card, rating);
    if (rating === 'again') queue.splice(Math.min(queue.length, 3), 0, card);
    else done += 1;
    revealed = false;
    show();
  }

  keyHandler = (e) => {
    if (queue.length === 0) return;
    if (!revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); revealed = true; show(); }
    else if (revealed && ['1', '2', '3', '4'].includes(e.key)) rate(['again', 'hard', 'good', 'easy'][+e.key - 1]);
  };
  document.addEventListener('keydown', keyHandler);
  show();
}

function viewStats() {
  const days = 7 * 20;
  const start = Date.now() - (days - 1) * DAY;
  const cells = [];
  for (let i = 0; i < days; i++) {
    const k = todayKey(start + i * DAY);
    const n = progress.log[k]?.reviews || 0;
    const lvl = n === 0 ? '' : n < 10 ? 'l1' : n < 30 ? 'l2' : n < 60 ? 'l3' : 'l4';
    cells.push(`<div class="${lvl}" title="${k}: ${n} Karten"></div>`);
  }
  let rev30 = 0, cor30 = 0;
  for (let i = 0; i < 30; i++) {
    const l = progress.log[todayKey(Date.now() - i * DAY)];
    if (l) { rev30 += l.reviews; cor30 += l.correct; }
  }
  const upcoming = Array.from({ length: 7 }, (_, i) => {
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const until = end.getTime() + i * DAY;
    let n = 0;
    for (const d of DECKS) for (const c of d.cards) {
      const st = stateOf(d.id, c.id);
      if (st && st.due <= until && (i === 0 || st.due > until - DAY)) n += 1;
    }
    return n;
  });
  const weekday = (i) => (i === 0 ? 'Heute' : new Date(Date.now() + i * DAY).toLocaleDateString('de-DE', { weekday: 'short' }));

  app.innerHTML = `
    <h1>Fortschritt</h1>
    <div class="panel stats">
      <div class="stat"><b>${streak()}</b><span>Tage Serie</span></div>
      <div class="stat"><b>${rev30}</b><span>Wiederholungen (30 T)</span></div>
      <div class="stat"><b>${rev30 ? Math.round((cor30 / rev30) * 100) : '–'}%</b><span>gewusst (30 T)</span></div>
    </div>
    <h2>Aktivität (20 Wochen)</h2>
    <div class="panel"><div class="heatmap">${cells.join('')}</div></div>
    <h2>Fällig in den nächsten 7 Tagen</h2>
    <div class="panel stats">${upcoming.map((n, i) => `<div class="stat"><b>${n}</b><span>${weekday(i)}</span></div>`).join('')}</div>
    <h2>Pro Modul</h2>
    <div class="grid">
      ${DECKS.map((d) => {
        const s = deckStats(d);
        const pct = s.total ? Math.round((s.mastered / s.total) * 100) : 0;
        return `<div class="panel deck" style="--deck:${d.color}">
          <h3>${esc(d.name)}</h3>
          <div class="small muted">${s.total} Karten · ${pct}% gefestigt</div>
          ${progressBar(s)}
          <div class="small">${s.new} neu · ${s.learning} lernend · ${s.mastered} gefestigt · ${s.due} fällig</div>
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

function viewSettings() {
  app.innerHTML = `
    <h1>Einstellungen</h1>
    <div class="panel" style="display:flex;flex-direction:column;gap:16px">
      <label>Neue Karten pro Tag und Modul:
        <input type="number" id="newPerDay" min="0" max="500" value="${progress.settings.newPerDay}" style="width:90px">
      </label>
      <div>
        <p class="small muted" style="margin:0 0 8px">Dein Fortschritt wird nur in diesem Browser gespeichert. Exportiere ihn, um ihn zu sichern oder auf ein anderes Gerät zu übertragen.</p>
        <div class="toolbar" style="margin:0">
          <button id="export">Fortschritt exportieren</button>
          <label class="btn">Fortschritt importieren<input type="file" id="import" accept="application/json" hidden></label>
          <button id="reset" style="color:var(--again)">Fortschritt zurücksetzen</button>
        </div>
      </div>
      <p class="small muted" id="msg" style="margin:0"></p>
    </div>
  `;
  const msg = app.querySelector('#msg');
  app.querySelector('#newPerDay').addEventListener('change', (e) => {
    progress.settings.newPerDay = Math.max(0, parseInt(e.target.value, 10) || 0);
    saveProgress();
    msg.textContent = 'Gespeichert.';
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
      msg.textContent = 'Fortschritt importiert.';
    } catch (err) {
      msg.textContent = `Import fehlgeschlagen: ${err.message}`;
    }
  });
  app.querySelector('#reset').addEventListener('click', () => {
    if (!confirm('Wirklich den gesamten Lernfortschritt löschen?')) return;
    progress = defaultProgress();
    saveProgress();
    msg.textContent = 'Fortschritt zurückgesetzt.';
  });
}

function viewNotFound() {
  app.innerHTML = '<p>Seite nicht gefunden. <a href="#/">Zur Übersicht</a></p>';
}

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
  .then(route)
  .catch((e) => {
    app.innerHTML = `<div class="panel"><p><b>Karten konnten nicht geladen werden.</b></p>
      <p class="small muted">${esc(e.message)}</p>
      <p class="small">Die App muss über einen Webserver geöffnet werden (z.&nbsp;B. GitHub Pages oder <code>python3 -m http.server</code>), nicht direkt als Datei.</p></div>`;
  });

// KaTeX wird per defer geladen und ist evtl. erst nach dem ersten Rendern verfügbar
window.addEventListener('load', () => renderMath(app));
