'use strict';

// ---------- Konstanten & Speicher ----------

const STORAGE_KEY = 'karteikarten-progress-v1';
const DAY = 24 * 60 * 60 * 1000;
const MASTERED_DAYS = 21; // ab diesem Intervall gilt eine Karte als "gefestigt"

const app = document.getElementById('app');
let DECKS = []; // [{id, name, prefix, color, cards: [...]}]

function defaultProgress() {
  // log: Lernstatistik dieses Geräts, otherLogs: die der anderen Geräte (per Sync)
  return { version: 1, cards: {}, log: {}, otherLogs: {}, newIntroduced: {}, settings: { newPerDay: 20, updatedAt: 0 } };
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
  scheduleSync();
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
  const sync = syncConfig();
  app.innerHTML = `
    <h1>Einstellungen</h1>
    <div class="panel" style="display:flex;flex-direction:column;gap:16px">
      <label>Neue Karten pro Tag und Modul:
        <input type="number" id="newPerDay" min="0" max="500" value="${progress.settings.newPerDay}" style="width:90px">
      </label>
    </div>

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

  app.querySelector('#newPerDay').addEventListener('change', (e) => {
    progress.settings.newPerDay = Math.max(0, parseInt(e.target.value, 10) || 0);
    progress.settings.updatedAt = Date.now();
    saveProgress();
    scheduleSync();
    say('Gespeichert.');
  });

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

// KaTeX wird per defer geladen und ist evtl. erst nach dem ersten Rendern verfügbar
window.addEventListener('load', () => renderMath(app));
