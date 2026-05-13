/* =========================================================
   Азбука — Cyrillic Companion
   Single-file vanilla JS app.
   Storage: IndexedDB. Audio out: Web Speech API.
   Audio in: MediaRecorder. No backend, no tracking.
   ========================================================= */

'use strict';

/* ---------- IndexedDB wrapper ---------- */
const DB_NAME = 'azbuka';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress', { keyPath: 'cardId' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'cardId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function withStore(store, mode) {
  const db = await openDB();
  return db.transaction(store, mode).objectStore(store);
}
const DB = {
  async put(store, obj) {
    const os = await withStore(store, 'readwrite');
    return new Promise((res, rej) => { const r = os.put(obj); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  },
  async bulkPut(store, arr) {
    if (!arr.length) return;
    const db = await openDB();
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const o of arr) os.put(o);
    return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
  },
  async get(store, key) {
    const os = await withStore(store, 'readonly');
    return new Promise((res, rej) => { const r = os.get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  },
  async getAll(store) {
    const os = await withStore(store, 'readonly');
    return new Promise((res, rej) => { const r = os.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  },
  async delete(store, key) {
    const os = await withStore(store, 'readwrite');
    return new Promise((res, rej) => { const r = os.delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
  },
  async clear(store) {
    const os = await withStore(store, 'readwrite');
    return new Promise((res, rej) => { const r = os.clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
  }
};

/* ---------- Settings ---------- */
const DEFAULTS = {
  newCardsPerDay: 20,          // total new cards per day (letters first, phrases fill the rest)
  reviewCap: 40,
  phraseCadenceDays: 1,        // legacy field — kept for backup-import compatibility, no longer used
  lastNewPhraseDate: null,
  phraseDirection: 'ru-to-pt', // 'ru-to-pt' shows Cyrillic on the front; 'pt-to-ru' is the legacy direction
  schedulingV2: false,         // marks completion of the unified-budget migration
  newSeenDate: null,           // legacy
  newSeenCount: 0,             // legacy
  newIntroDate: null,          // yyyy-mm-dd of last new-card-intro tracking
  newIntroCount: 0,            // how many fresh cards have been first-seen today
  theme: 'auto',
  preferredVoice: 'recorded',
  alphabetView: 'grouped',     // 'grouped' | 'sequential'
  starterVersion: 0,
  lastSessionDate: null,
  streak: 0,
  backupReminder: Date.now()
};

// Pedagogical grouping — same-as-Latin, false friends, new shapes.
const LETTER_GROUPS = [
  { id: 'same',  label: 'Iguais ao latim',  hint: 'mesma forma, mesmo som',       letters: ['А','Е','К','М','О','Т'] },
  { id: 'false', label: 'Falsos amigos',    hint: 'parecem latinas, soam outra coisa', letters: ['В','Н','Р','С','У','Х'] },
  { id: 'new',   label: 'Formas novas',     hint: 'só no cirílico',               letters: ['Б','Г','Д','Ё','Ж','З','И','Й','Л','П','Ф','Ц','Ч','Ш','Щ','Ъ','Ы','Ь','Э','Ю','Я'] }
];

async function loadSettings() {
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = await DB.get('settings', k);
    if (v && v.value !== undefined) s[k] = v.value;
  }
  return s;
}
async function setSetting(key, value) {
  state.settings[key] = value;
  await DB.put('settings', { key, value });
}

/* ---------- SM-2 spaced repetition ---------- */
const RATE = { AGAIN: 0, GOOD: 3, EASY: 5 };

function newProgress(cardId) {
  return { cardId, easeFactor: 2.5, interval: 0, repetitions: 0, lapses: 0, dueDate: 0, lastReviewed: 0 };
}

function sm2(prog, quality) {
  let { easeFactor, interval, repetitions, lapses } = prog;
  easeFactor ??= 2.5; interval ??= 0; repetitions ??= 0; lapses ??= 0;

  if (quality < 3) {
    repetitions = 0;
    interval = 0;       // same session re-show, but due "now" (< 10min)
    lapses += 1;
  } else {
    if (repetitions === 0) interval = 1;
    else if (repetitions === 1) interval = quality >= 5 ? 4 : 3;
    else interval = Math.max(1, Math.round(interval * easeFactor * (quality >= 5 ? 1.3 : 1)));
    repetitions += 1;
  }
  easeFactor = Math.max(1.3, easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
  const now = Date.now();
  const dueDate = quality < 3 ? now + 10 * 60 * 1000 : now + interval * 86400000;
  return { ...prog, easeFactor, interval, repetitions, lapses, dueDate, lastReviewed: now };
}

/* ---------- TTS ---------- */
const TTS = {
  voice: null,
  ready: false,
  init() {
    if (!('speechSynthesis' in window)) return;
    const pick = () => {
      const voices = speechSynthesis.getVoices();
      this.voice = voices.find(v => /^ru(-|$)/i.test(v.lang)) || null;
      this.ready = voices.length > 0;
    };
    pick();
    if ('onvoiceschanged' in speechSynthesis) {
      speechSynthesis.addEventListener('voiceschanged', pick);
    }
  },
  speak(text, { lang = 'ru-RU', rate = 0.92 } = {}) {
    if (!('speechSynthesis' in window) || !text) return;
    try { speechSynthesis.cancel(); } catch {}
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = rate;
    if (this.voice && lang.startsWith('ru')) u.voice = this.voice;
    speechSynthesis.speak(u);
  },
  speakSequence(texts, { lang = 'ru-RU', rate = 0.92 } = {}) {
    if (!('speechSynthesis' in window)) return;
    try { speechSynthesis.cancel(); } catch {}
    for (const text of texts.filter(Boolean)) {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = rate;
      if (this.voice && lang.startsWith('ru')) u.voice = this.voice;
      speechSynthesis.speak(u);
    }
  },
  hasRussian() { return !!this.voice; }
};

/* ---------- Recorder ---------- */
class Recorder {
  constructor() { this.mr = null; this.chunks = []; this.stream = null; }
  supported() { return 'MediaRecorder' in window && !!navigator.mediaDevices?.getUserMedia; }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
    const mime = mimes.find(m => MediaRecorder.isTypeSupported(m)) || '';
    this.mr = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream);
    this.chunks = [];
    this.mr.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.mr.start();
  }
  stop() {
    return new Promise(resolve => {
      if (!this.mr) return resolve(null);
      this.mr.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mr?.mimeType || 'audio/webm' });
        try { this.stream?.getTracks().forEach(t => t.stop()); } catch {}
        this.stream = null; this.mr = null;
        resolve(blob);
      };
      this.mr.stop();
    });
  }
  isRecording() { return this.mr?.state === 'recording'; }
}
const recorder = new Recorder();

/* ---------- App state ---------- */
const state = {
  settings: { ...DEFAULTS },
  cards: [],
  progress: {},           // { cardId: Progress }
  session: null,          // { queue, index, stats: { again, good, easy } }
  currentTab: 'dashboard',
  playingAudioEl: null,
  reading: null,          // { index, weeks: {weekId: week}, currentWeekId, todayDate }
  readingViewing: null,   // { weekId, date } — currently-displayed reading
  readingShowPt: false    // toggle: PT translation visible on reader view
};

/* ---------- DOM helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k === 'style') e.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'disabled' || k === 'hidden' || k === 'checked') { if (v) e[k] = true; }
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'object' && 'nodeType' in c ? c : document.createTextNode(String(c)));
  }
  return e;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._tm);
  toast._tm = setTimeout(() => { t.hidden = true; }, 2400);
}
function todayStr(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function yesterdayStr() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return todayStr(d);
}
function uid(prefix = 'U') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/* ---------- Planning / stats ---------- */
function categoryLabel(c) {
  return { alphabet: 'alfabeto', romantic: 'romance', family: 'família', survival: 'sobrevivência', numbers: 'números', vocab: 'vocabulário', countries: 'países', verbs: 'verbos', custom: 'pessoal' }[c] || c;
}

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const last = new Date(`${dateStr}T00:00:00`);
  const today = new Date(`${todayStr()}T00:00:00`);
  return Math.floor((today - last) / 86400000);
}

function isFresh(p) {
  // "Fresh" = never been studied. A card rated "De novo" stays at repetitions=0
  // but has lastReviewed > 0; treat that as in-flight, not fresh.
  if (!p) return true;
  return p.repetitions === 0 && (p.lastReviewed || 0) === 0;
}
function isDue(p, now) {
  // Anything with a tick on the clock and a past due date is up for review,
  // including "De novo"-ed cards once their 10-min timer elapses.
  return !!p && (p.lastReviewed || 0) > 0 && (p.dueDate || 0) <= now;
}
function priorityOf(c) {
  // Lower number = surfaces sooner. Default for legacy cards: 5.
  return Number.isFinite(c?.priority) ? c.priority : 5;
}

function newIntrosRemainingToday() {
  // Cap on FIRST-SIGHT card introductions today (reviews aren't capped here).
  const cap = state.settings.newCardsPerDay || 0;
  if (state.settings.newIntroDate !== todayStr()) return cap;
  return Math.max(0, cap - (state.settings.newIntroCount || 0));
}

function countsForToday() {
  const now = Date.now();
  let dueLetters = 0, freshLetters = 0;
  let duePhrases = 0, freshPhrases = 0;
  let mastered = 0;
  for (const c of state.cards) {
    const p = state.progress[c.id];
    if (c.type === 'letter') {
      if (isFresh(p)) freshLetters++;
      else if (isDue(p, now)) dueLetters++;
    } else {
      if (isFresh(p)) freshPhrases++;
      else if (isDue(p, now)) duePhrases++;
    }
    if (p && p.interval >= 14) mastered++;
  }
  // New-card intros are capped per day; reviews flow on top (capped per session).
  const newBudget = newIntrosRemainingToday();
  const newLettersToday = Math.min(freshLetters, newBudget);
  const newPhrasesToday = Math.min(freshPhrases, Math.max(0, newBudget - newLettersToday));
  const dueLettersToday = Math.min(dueLetters, state.settings.reviewCap);
  const duePhrasesToday = Math.min(duePhrases, state.settings.reviewCap);
  const sessionSize = dueLettersToday + duePhrasesToday + newLettersToday + newPhrasesToday;
  return {
    dueLetters, freshLetters, duePhrases, freshPhrases,
    newLettersToday, dueLettersToday, newPhrasesToday, duePhrasesToday,
    newBudget,
    newDailyCap: state.settings.newCardsPerDay || 0,
    sessionSize,
    total: state.cards.length,
    mastered
  };
}

function planSession() {
  const now = Date.now();
  const letters = state.cards.filter(c => c.type === 'letter');
  const phrases = state.cards.filter(c => c.type !== 'letter');

  const dueLettersAll = letters
    .filter(c => isDue(state.progress[c.id], now))
    .sort((a, b) => state.progress[a.id].dueDate - state.progress[b.id].dueDate);
  const duePhrasesAll = phrases
    .filter(c => isDue(state.progress[c.id], now))
    .sort((a, b) => state.progress[a.id].dueDate - state.progress[b.id].dueDate);

  // Fresh cards sort by priority first, then by id — so high-priority decks
  // (e.g. numbers, this-week's vocab) surface before lower-priority ones.
  const priSort = (a, b) => priorityOf(a) - priorityOf(b) || (a.id < b.id ? -1 : 1);
  const freshLettersAll = letters.filter(c => isFresh(state.progress[c.id])).sort(priSort);
  const freshPhrasesAll = phrases.filter(c => isFresh(state.progress[c.id])).sort(priSort);

  const newBudget = newIntrosRemainingToday();
  const reviewCap = state.settings.reviewCap;
  const dueLetters = dueLettersAll.slice(0, reviewCap);
  const duePhrases = duePhrasesAll.slice(0, reviewCap);
  const freshLetters = freshLettersAll.slice(0, newBudget);
  const freshPhrases = freshPhrasesAll.slice(0, Math.max(0, newBudget - freshLetters.length));

  // Reviews first (memory pressure), then new material.
  return [...dueLetters, ...duePhrases, ...freshLetters, ...freshPhrases];
}

function isMastered(p) { return p && p.interval >= 14; }

/* ---------- Daily reading ---------- */
function isoWeekId(d = new Date()) {
  const u = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = u.getUTCDay() || 7;
  u.setUTCDate(u.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(u.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((u - yearStart) / 86400000 + 1) / 7);
  return `${u.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function fetchWeekFile(file) {
  const res = await fetch(`paragraphs/${file}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadReading() {
  try {
    const idxRes = await fetch('paragraphs/index.json', { cache: 'no-cache' });
    if (!idxRes.ok) return;
    const index = await idxRes.json();
    const today = todayStr();
    const wantWeek = isoWeekId();
    // Pick the requested ISO week if available; otherwise the most recent we have.
    const weekEntry = index.weeks.find(w => w.id === wantWeek)
      || [...index.weeks].sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0];
    if (!weekEntry) return;
    const week = await fetchWeekFile(weekEntry.file);
    const sortedDays = [...week.days].sort((a, b) => (a.date < b.date ? -1 : 1));
    const todayEntry = sortedDays.find(d => d.date === today)
      || [...sortedDays].reverse().find(d => d.date <= today)
      || sortedDays[0];
    state.reading = {
      index,
      weeks: { [week.week]: week },
      currentWeekId: week.week,
      todayDate: todayEntry?.date || null
    };
  } catch (err) {
    console.warn('Failed to load reading', err);
  }
}

function readingTodayEntry() {
  const r = state.reading;
  if (!r) return null;
  const week = r.weeks[r.currentWeekId];
  return week?.days.find(d => d.date === r.todayDate) || null;
}

function readingViewingDay() {
  const r = state.reading;
  const v = state.readingViewing;
  if (!r || !v) return null;
  const week = r.weeks[v.weekId];
  return week?.days.find(d => d.date === v.date) || null;
}

async function openReadingWeek(weekId) {
  const r = state.reading;
  if (!r) return;
  if (!r.weeks[weekId]) {
    const entry = r.index.weeks.find(w => w.id === weekId);
    if (!entry) return;
    try {
      r.weeks[weekId] = await fetchWeekFile(entry.file);
    } catch (err) {
      toast('Não foi possível carregar a leitura.');
      console.warn(err);
      return;
    }
  }
  const days = [...r.weeks[weekId].days].sort((a, b) => (a.date < b.date ? -1 : 1));
  const today = todayStr();
  const startDay = days.find(d => d.date === today)
    || [...days].reverse().find(d => d.date <= today)
    || days[days.length - 1];
  state.readingViewing = { weekId, date: startDay.date };
  state.readingShowPt = false;
  renderReading();
  window.scrollTo(0, 0);
}

function renderReadingTile() {
  const today = readingTodayEntry();
  if (!today) return null;
  const kindLabel = today.kind === 'story' ? 'História' : 'Notícia';
  return el('button', {
    class: 'reading-tile',
    onclick: () => {
      state.readingViewing = { weekId: state.reading.currentWeekId, date: state.reading.todayDate };
      state.readingShowPt = false;
      showView('reading');
    }
  },
    el('div', { class: 'reading-tile-label' }, `Leitura · ${kindLabel}`),
    el('div', { class: 'reading-tile-title' }, today.title),
    el('div', { class: 'reading-tile-hint' }, `Tocar para ler — ${today.ru.split(/[.!?]+/).filter(Boolean).length} frases · ${(today.notes || []).length} palavras`)
  );
}

function renderReading() {
  const root = $('#view-reading');
  root.innerHTML = '';
  if (!state.reading) {
    root.appendChild(el('div', { class: 'empty' }, 'Nenhuma leitura disponível.'));
    return;
  }
  // Default the viewing pointer to today if none set (e.g. landed via Settings → archive).
  if (!state.readingViewing) {
    state.readingViewing = { weekId: state.reading.currentWeekId, date: state.reading.todayDate };
  }
  const day = readingViewingDay();
  if (!day) {
    root.appendChild(el('div', { class: 'empty' }, 'Leitura não encontrada.'));
    return;
  }
  const week = state.reading.weeks[state.readingViewing.weekId];

  const wrap = el('div', { class: 'reader-wrap' });

  const kindLabel = day.kind === 'story' ? 'História' : 'Notícia';
  const onPastWeek = state.readingViewing.weekId !== state.reading.currentWeekId;
  wrap.appendChild(el('div', { class: 'reader-meta' },
    `${kindLabel} · ${day.date}` + (onPastWeek ? ` · ${week.week}` : '')
  ));
  wrap.appendChild(el('h2', { class: 'reader-title' }, day.title));
  wrap.appendChild(el('div', { class: 'reader-paragraph' }, day.ru));
  if (day.transliteration) {
    wrap.appendChild(el('div', { class: 'reader-translit' }, day.transliteration));
  }

  const actions = el('div', { class: 'reader-actions' },
    el('button', {
      class: 'btn btn-ghost flex-grow',
      onclick: () => { state.readingShowPt = !state.readingShowPt; renderReading(); }
    }, state.readingShowPt ? 'Ocultar tradução' : 'Ver tradução'),
    el('button', {
      class: 'btn btn-ghost',
      onclick: () => TTS.speak(day.ru, { rate: 0.85 })
    }, '♪ Ouvir')
  );
  wrap.appendChild(actions);

  if (state.readingShowPt) {
    wrap.appendChild(el('div', { class: 'reader-translation' }, day.pt));
  }

  if (day.notes?.length) {
    const gloss = el('div', { class: 'reader-glossary' }, el('h3', {}, 'Glossário'));
    for (const n of day.notes) {
      gloss.appendChild(el('div', { class: 'gloss-item' },
        el('div', { class: 'gloss-row' },
          el('span', { class: 'gloss-ru' }, n.ru),
          el('span', { class: 'gloss-arrow' }, '→'),
          el('span', { class: 'gloss-pt' }, n.pt)
        ),
        n.note ? el('div', { class: 'gloss-note' }, n.note) : null
      ));
    }
    wrap.appendChild(gloss);
  }

  // Other days within the same week
  const otherDays = [...week.days]
    .filter(d => d.date !== day.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (otherDays.length) {
    const sameWeek = el('div', { class: 'reader-archive' },
      el('h3', { class: 'reader-glossary', style: 'margin: 0 0 10px;' }, 'Outros dias desta semana')
    );
    for (const d of otherDays) {
      sameWeek.appendChild(el('button', {
        class: 'archive-item',
        onclick: () => {
          state.readingViewing = { weekId: week.week, date: d.date };
          state.readingShowPt = false;
          renderReading();
          window.scrollTo(0, 0);
        }
      },
        el('div', { class: 'archive-item-date' }, `${d.date} · ${d.kind === 'story' ? 'História' : 'Notícia'}`),
        el('div', { class: 'archive-item-title' }, d.title)
      ));
    }
    wrap.appendChild(sameWeek);
  }

  // Past weeks (auto-archive of older bundles)
  const otherWeeks = state.reading.index.weeks
    .filter(w => w.id !== week.week)
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  if (otherWeeks.length) {
    const past = el('div', { class: 'reader-archive' },
      el('h3', { class: 'reader-glossary', style: 'margin: 0 0 10px;' }, 'Semanas anteriores')
    );
    for (const w of otherWeeks) {
      past.appendChild(el('button', {
        class: 'archive-item',
        onclick: () => openReadingWeek(w.id)
      },
        el('div', { class: 'archive-item-date' }, `${w.id} · ${w.startDate} → ${w.endDate}`),
        el('div', { class: 'archive-item-title' }, 'Abrir semana')
      ));
    }
    wrap.appendChild(past);
  }

  root.appendChild(wrap);
}

/* ---------- Router ---------- */
function showView(name) {
  state.currentTab = name;
  const titles = { dashboard: 'Азбука', study: 'Estudo', add: 'Nova carta', browse: 'Cartas', reading: 'Leitura', settings: 'Ajustes' };
  $('#topbar-title').textContent = titles[name] || 'Азбука';
  for (const v of $$('.view')) v.hidden = v.id !== `view-${name}`;
  for (const t of $$('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  // Render current view fresh on every navigation
  const renderers = {
    dashboard: renderDashboard,
    study: renderStudyHome,
    add: renderAdd,
    browse: renderBrowse,
    reading: renderReading,
    settings: renderSettings
  };
  renderers[name]?.();
  window.scrollTo(0, 0);
}

/* ---------- Dashboard ---------- */
function renderDashboard() {
  const root = $('#view-dashboard');
  root.innerHTML = '';
  const counts = countsForToday();

  const bits = [];
  const newTotal = counts.newLettersToday + counts.newPhrasesToday;
  const dueTotal = counts.dueLettersToday + counts.duePhrasesToday;
  if (newTotal) {
    bits.push(`${newTotal}/${counts.newDailyCap} ${newTotal > 1 ? 'novas' : 'nova'}`);
  }
  if (dueTotal) {
    bits.push(`${dueTotal} ${dueTotal > 1 ? 'revisões' : 'revisão'}`);
  }

  const hero = el('div', { class: 'hero' },
    el('div', { class: 'hero-label' }, 'Hoje'),
    el('div', { class: 'hero-count' }, String(counts.sessionSize)),
    el('div', { class: 'hero-sub' },
      counts.sessionSize === 0
        ? 'Nenhuma carta pendente. Volte mais tarde.'
        : bits.join(' · ')
    ),
    el('button', {
      class: 'hero-cta',
      disabled: counts.sessionSize === 0,
      onclick: () => startSession()
    }, counts.sessionSize === 0 ? 'Tudo em dia ✓' : 'Estudar agora')
  );
  root.appendChild(hero);

  const readingTile = renderReadingTile();
  if (readingTile) root.appendChild(readingTile);

  const stats = el('div', { class: 'stats-row' },
    el('div', { class: 'stat' },
      el('div', { class: 'stat-v' }, String(state.settings.streak)),
      el('div', { class: 'stat-l' }, 'Dias seguidos')
    ),
    el('div', { class: 'stat' },
      el('div', { class: 'stat-v' }, String(counts.mastered)),
      el('div', { class: 'stat-l' }, 'Dominadas')
    ),
    el('div', { class: 'stat' },
      el('div', { class: 'stat-v' }, String(counts.total)),
      el('div', { class: 'stat-l' }, 'Total')
    )
  );
  root.appendChild(stats);

  // Alphabet heatmap
  const letters = state.cards.filter(c => c.type === 'letter' && c.category === 'alphabet');
  if (letters.length) {
    const header = el('div', { class: 'alpha-header mt-2' },
      el('h3', { style: 'margin: 0;' }, 'Alfabeto cirílico'),
      el('div', { class: 'seg seg-sm' },
        el('button', {
          class: state.settings.alphabetView === 'grouped' ? 'active' : '',
          onclick: async () => { await setSetting('alphabetView', 'grouped'); renderDashboard(); }
        }, 'Agrupado'),
        el('button', {
          class: state.settings.alphabetView === 'sequential' ? 'active' : '',
          onclick: async () => { await setSetting('alphabetView', 'sequential'); renderDashboard(); }
        }, 'Sequencial')
      )
    );
    root.appendChild(header);
    if (state.settings.alphabetView === 'grouped') {
      renderAlphabetGrouped(root, letters);
    } else {
      renderAlphabetSequential(root, letters);
    }
  }

  // Quick tips
  if (counts.total < 10) {
    root.appendChild(el('div', { class: 'card mt-2 center muted small' },
      'Dica: o baralho inicial tem 78 cartas. Se você vê poucas, reimporte pelos ajustes.'
    ));
  }
}

function quickPlay(card) {
  if (card.type === 'letter') {
    const texts = [letterSpoken(card), card.example?.ru].filter(Boolean);
    if (texts.length) TTS.speakSequence(texts);
  } else {
    const text = russianAudioText(card);
    if (text) TTS.speak(text);
  }
}

function alphaCell(card) {
  const p = state.progress[card.id];
  const cls = p && isMastered(p) ? 'alpha-cell mastered'
            : p && p.repetitions > 0 ? 'alpha-cell learning'
            : 'alpha-cell';
  const glyph = letterGlyph(card);
  return el('button', { class: cls, onclick: () => quickPlay(card) }, glyph);
}

function renderAlphabetSequential(root, letters) {
  const grid = el('div', { class: 'alpha-grid' });
  for (const card of letters) grid.appendChild(alphaCell(card));
  root.appendChild(grid);
}

function renderAlphabetGrouped(root, letters) {
  const byGlyph = new Map(letters.map(c => [letterGlyph(c), c]));
  for (const group of LETTER_GROUPS) {
    const section = el('div', { class: 'alpha-group' },
      el('div', { class: 'alpha-group-head' },
        el('span', { class: 'alpha-group-label' }, group.label),
        el('span', { class: 'alpha-group-hint' }, group.hint)
      )
    );
    const grid = el('div', { class: 'alpha-grid' });
    for (const glyph of group.letters) {
      const card = byGlyph.get(glyph);
      if (card) grid.appendChild(alphaCell(card));
    }
    section.appendChild(grid);
    root.appendChild(section);
  }
}

/* ---------- Study ---------- */
function startSession() {
  const queue = planSession();
  if (!queue.length) { toast('Nada para revisar agora.'); return; }
  state.session = { queue, index: 0, stats: { again: 0, good: 0, easy: 0 }, answered: 0, total: queue.length };
  showView('study');
}

function renderStudyHome() {
  const root = $('#view-study');
  root.innerHTML = '';
  if (!state.session) {
    // offer start
    const counts = countsForToday();
    root.appendChild(el('div', { class: 'card center' },
      el('h2', {}, 'Pronto para uma sessão?'),
      el('p', { class: 'muted' }, counts.sessionSize === 0
        ? 'Sem cartas pendentes no momento.'
        : `${counts.dueForToday} revisões + ${counts.newForToday} novas = ${counts.sessionSize} cartas`),
      el('button', { class: 'btn btn-block', disabled: counts.sessionSize === 0, onclick: () => startSession() },
        counts.sessionSize === 0 ? 'Tudo em dia ✓' : 'Começar sessão')
    ));
    return;
  }
  renderSessionCard();
}

function renderSessionCard() {
  const root = $('#view-study');
  root.innerHTML = '';
  const s = state.session;
  if (!s || s.index >= s.queue.length) { return renderSessionDone(); }

  const card = s.queue[s.index];
  const p = state.progress[card.id] || newProgress(card.id);
  const isNew = p.repetitions === 0;

  const header = el('div', { class: 'study-header' },
    el('button', { class: 'icon-btn', 'aria-label': 'Sair', onclick: () => quitSession() }, '×'),
    el('div', { class: 'progress' }, el('div', { class: 'progress-bar', style: `width:${(s.index / s.total) * 100}%` })),
    el('div', { class: 'study-count' }, `${s.index + 1}/${s.total}`)
  );

  const flashcard = el('div', { class: 'flashcard', id: 'flashcard' });
  const catBadge = el('div', { class: 'card-meta' }, categoryLabel(card.category || 'custom'), isNew ? ' · nova' : '');
  flashcard.appendChild(catBadge);

  const front = renderFront(card);
  const back = renderBack(card);
  flashcard.appendChild(front);
  flashcard.appendChild(back);
  flashcard.appendChild(el('div', { class: 'card-hint' }, 'Toque para virar'));

  flashcard.addEventListener('click', (e) => {
    if (e.target.closest('.btn-audio')) return;
    if (!flashcard.classList.contains('flipped')) {
      flashcard.classList.add('flipped');
      playCardAudio(card);
    } else {
      // Allow flipping back to peek at the front again.
      flashcard.classList.remove('flipped');
    }
  });

  root.appendChild(header);
  root.appendChild(flashcard);

  // Rate row (shown always, disabled until flipped)
  const rate = el('div', { class: 'rate-row' },
    el('button', { class: 'btn-rate again', onclick: () => onRate(RATE.AGAIN) },
      el('span', { class: 'rate-label' }, 'De novo'),
      el('span', { class: 'rate-hint' }, '< 10 min')
    ),
    el('button', { class: 'btn-rate good', onclick: () => onRate(RATE.GOOD) },
      el('span', { class: 'rate-label' }, 'Sei'),
      el('span', { class: 'rate-hint' }, intervalHint(p, RATE.GOOD))
    ),
    el('button', { class: 'btn-rate easy', onclick: () => onRate(RATE.EASY) },
      el('span', { class: 'rate-label' }, 'Fácil'),
      el('span', { class: 'rate-hint' }, intervalHint(p, RATE.EASY))
    )
  );
  root.appendChild(rate);
}

function intervalHint(p, q) {
  const pre = sm2(p, q);
  const days = pre.interval;
  if (days === 0) return '< 10 min';
  if (days === 1) return '1 dia';
  if (days < 30) return `${days} dias`;
  if (days < 365) return `${Math.round(days / 30)} meses`;
  return `${Math.round(days / 365)} anos`;
}

function letterGlyph(card) {
  // "А а" → "А" (uppercase form, for visual display).
  return (card.front?.text || '').trim().split(/\s+/)[0] || '';
}
// Russian phonetic name for each letter (how Russians read a letter aloud).
// Using the raw glyph makes iOS TTS announce the case ("заглавная А ..."),
// so we feed the phonetic name instead.
const LETTER_NAMES = {
  'А':'а', 'Б':'бэ', 'В':'вэ', 'Г':'гэ', 'Д':'дэ',
  'Е':'е', 'Ё':'ё', 'Ж':'жэ', 'З':'зэ', 'И':'и',
  'Й':'и краткое', 'К':'ка', 'Л':'эль', 'М':'эм', 'Н':'эн',
  'О':'о', 'П':'пэ', 'Р':'эр', 'С':'эс', 'Т':'тэ',
  'У':'у', 'Ф':'эф', 'Х':'ха', 'Ц':'цэ', 'Ч':'че',
  'Ш':'ша', 'Щ':'ща', 'Ъ':'твёрдый знак', 'Ы':'ы',
  'Ь':'мягкий знак', 'Э':'э', 'Ю':'ю', 'Я':'я'
};
function letterSpoken(card) {
  const g = letterGlyph(card);
  return LETTER_NAMES[g] || g;
}
function stripMarkup(text) { return text ? text.replace(/\*\*/g, '') : text; }
function russianAudioText(card) {
  if (card.back?.language === 'ru') return stripMarkup(card.back.text);
  if (card.front?.language === 'ru') return stripMarkup(card.front.text);
  return null;
}

function isCyrillicFirst(card) {
  return card.type !== 'letter' && state.settings.phraseDirection === 'ru-to-pt';
}

function nodesFromMarkup(text) {
  // Tiny **bold** parser — used to emphasise the target word/phrase in
  // example-sentence cards and reader paragraphs. Plain text otherwise.
  if (!text || !text.includes('**')) return [document.createTextNode(text || '')];
  const re = /\*\*([^*\n]+)\*\*/g;
  const out = [];
  let last = 0; let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    out.push(el('strong', { class: 'em-focus' }, m[1]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function renderFront(card) {
  const face = el('div', { class: 'face face-front' });
  const isLetter = card.type === 'letter';
  const frontText = isCyrillicFirst(card) ? card.back.text : card.front.text;
  face.appendChild(el('div', { class: `front-text ${isLetter ? 'letter' : 'phrase'}` }, ...nodesFromMarkup(frontText)));
  if (isLetter && card.example?.ru) {
    face.appendChild(el('div', { class: 'front-example' }, card.example.ru));
  }
  return face;
}

function renderBack(card) {
  const face = el('div', { class: 'face face-back' });
  const isLetter = card.type === 'letter';
  const cyrillicFirst = isCyrillicFirst(card);

  // Header: letter keeps the Cyrillic glyph visible and shows its sound next to it.
  if (isLetter) {
    face.appendChild(el('div', { class: 'back-letter-header' },
      el('span', { class: 'back-cyrillic' }, card.front.text),
      el('span', { class: 'back-arrow' }, '→'),
      el('span', { class: 'back-sound' }, card.back.text)
    ));
  } else if (cyrillicFirst) {
    // Cyrillic on the front → reveal Portuguese translation here.
    face.appendChild(el('div', { class: 'back-main' }, ...nodesFromMarkup(card.front.text)));
  } else {
    face.appendChild(el('div', { class: 'back-main' }, ...nodesFromMarkup(card.back.text)));
  }

  // Pronunciation note (letters) or transliteration (phrases)
  if (isLetter) {
    if (card.back.note) face.appendChild(el('div', { class: 'back-note' }, card.back.note));
    if (card.example) {
      const block = el('div', { class: 'back-example' },
        el('span', { class: 'back-example-ru' }, card.example.ru),
        el('span', { class: 'back-example-sep' }, '—'),
        el('span', { class: 'back-example-pt' }, card.example.pt)
      );
      face.appendChild(block);
      if (card.example.translit) {
        face.appendChild(el('div', { class: 'back-example-translit' }, card.example.translit));
      }
    }
  } else {
    if (card.back.transliteration) {
      face.appendChild(el('div', { class: 'back-translit' }, card.back.transliteration));
    }
    if (card.back.note) {
      face.appendChild(el('div', { class: 'back-note' }, card.back.note));
    }
  }

  // Audio buttons
  const row = el('div', { class: 'back-audio-row' });
  if (isLetter) {
    const letterName = letterSpoken(card);
    if (letterName) {
      row.appendChild(el('button', {
        class: 'btn-audio',
        onclick: (ev) => { ev.stopPropagation(); TTS.speak(letterName, { rate: 0.85 }); }
      }, '♪ Letra'));
    }
    if (card.example?.ru) {
      row.appendChild(el('button', {
        class: 'btn-audio',
        onclick: (ev) => { ev.stopPropagation(); TTS.speak(card.example.ru); }
      }, '♪ Palavra'));
    }
  } else {
    const ruText = russianAudioText(card);
    if (ruText) {
      row.appendChild(el('button', {
        class: 'btn-audio',
        onclick: (ev) => { ev.stopPropagation(); TTS.speak(ruText); }
      }, '♪ Ouvir'));
    }
  }
  DB.get('audio', card.id).then(rec => {
    if (rec?.blob) {
      row.appendChild(el('button', {
        class: 'btn-audio',
        onclick: (ev) => { ev.stopPropagation(); playBlob(rec.blob); }
      }, '♥ Voz dela'));
    }
  });
  face.appendChild(row);
  return face;
}

function playCardAudio(card) {
  // Letters: play the letter's Russian name, then the example word.
  // Phrases: play the Russian side.
  const isLetter = card.type === 'letter';
  const texts = isLetter
    ? [letterSpoken(card), card.example?.ru]
    : [russianAudioText(card)];
  if (!texts.some(Boolean)) return;

  DB.get('audio', card.id).then(rec => {
    if (rec?.blob && state.settings.preferredVoice === 'recorded') {
      playBlob(rec.blob);
    } else if (isLetter) {
      TTS.speakSequence(texts);
    } else {
      TTS.speak(texts[0]);
    }
  });
}
function playBlob(blob) {
  try {
    if (state.playingAudioEl) { state.playingAudioEl.pause(); URL.revokeObjectURL(state.playingAudioEl.src); }
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    state.playingAudioEl = a;
    a.play().catch(() => {});
    a.onended = () => URL.revokeObjectURL(url);
  } catch {}
}

async function onRate(quality) {
  const s = state.session;
  if (!s) return;
  const card = s.queue[s.index];
  const fc = $('#flashcard');
  // Require flip first
  if (fc && !fc.classList.contains('flipped')) {
    fc.classList.add('flipped');
    return;
  }
  const prev = state.progress[card.id] || newProgress(card.id);
  const wasFirstSight = (prev.lastReviewed || 0) === 0;
  const next = sm2(prev, quality);
  state.progress[card.id] = next;
  await DB.put('progress', next);
  if (wasFirstSight) {
    const today = todayStr();
    const sameDay = state.settings.newIntroDate === today;
    await setSetting('newIntroDate', today);
    await setSetting('newIntroCount', (sameDay ? (state.settings.newIntroCount || 0) : 0) + 1);
  }

  if (quality === RATE.AGAIN) {
    s.stats.again++;
    // Re-queue same card near the end (learn-again loop)
    const reinsertAt = Math.min(s.queue.length, s.index + 4);
    s.queue.splice(reinsertAt, 0, card);
  } else if (quality === RATE.GOOD) s.stats.good++;
  else if (quality === RATE.EASY) s.stats.easy++;

  s.index += 1;
  s.total = s.queue.length;  // grows when "again" reinserts
  s.answered += 1;
  if (s.index >= s.queue.length) return finishSession();
  renderSessionCard();
}

async function finishSession() {
  await bumpStreak();
  renderSessionDone();
}

async function bumpStreak() {
  const today = todayStr();
  const last = state.settings.lastSessionDate;
  if (last === today) return;
  let streak = state.settings.streak || 0;
  if (last === yesterdayStr()) streak += 1;
  else streak = 1;
  await setSetting('streak', streak);
  await setSetting('lastSessionDate', today);
}

function renderSessionDone() {
  const root = $('#view-study');
  root.innerHTML = '';
  const s = state.session || { stats: { again: 0, good: 0, easy: 0 }, answered: 0 };
  root.appendChild(el('div', { class: 'card session-done' },
    el('span', { class: 'big-emoji' }, 'Я'),
    el('h1', {}, 'Молодец!'),
    el('p', { class: 'muted' }, `Terminou ${s.answered || 0} cartas hoje.`),
    el('div', { class: 'stats-row mt-2' },
      el('div', { class: 'stat' },
        el('div', { class: 'stat-v', style: 'color: var(--bad);' }, String(s.stats.again)),
        el('div', { class: 'stat-l' }, 'De novo')
      ),
      el('div', { class: 'stat' },
        el('div', { class: 'stat-v', style: 'color: var(--good);' }, String(s.stats.good)),
        el('div', { class: 'stat-l' }, 'Sei')
      ),
      el('div', { class: 'stat' },
        el('div', { class: 'stat-v', style: 'color: var(--accent);' }, String(s.stats.easy)),
        el('div', { class: 'stat-l' }, 'Fácil')
      )
    ),
    el('div', { class: 'row mt-2' },
      el('button', { class: 'btn btn-ghost', onclick: () => { state.session = null; showView('dashboard'); } }, 'Para casa'),
      el('button', { class: 'btn', onclick: () => { state.session = null; startSession(); } }, 'Mais uma')
    )
  ));
  state.session = null;
}

function quitSession() {
  if (!state.session) return showView('dashboard');
  if (state.session.index > 0) {
    if (!confirm('Sair e perder o progresso da sessão atual?')) return;
  }
  state.session = null;
  showView('dashboard');
}

/* ---------- Add / Edit ---------- */
let editingCardId = null;

function renderAdd() {
  const root = $('#view-add');
  root.innerHTML = '';
  const editing = editingCardId ? state.cards.find(c => c.id === editingCardId) : null;

  const type = editing?.type || 'phrase';
  const category = editing?.category || 'custom';
  const frontText = editing?.front?.text || '';
  const backText = editing?.back?.text || '';
  const translit = editing?.back?.transliteration || '';
  const note = editing?.back?.note || '';

  const form = el('div', { class: 'card' },
    el('h2', {}, editing ? 'Editar carta' : 'Nova carta'),
    // Type
    el('div', { class: 'form-group' },
      el('label', {}, 'Tipo'),
      el('div', { class: 'seg' },
        el('button', { class: type === 'phrase' ? 'active' : '', onclick: () => { typeInput.value = 'phrase'; updateTypeUI('phrase'); } }, 'Frase'),
        el('button', { class: type === 'letter' ? 'active' : '', onclick: () => { typeInput.value = 'letter'; updateTypeUI('letter'); } }, 'Letra')
      ),
      el('input', { type: 'hidden', id: '_type', value: type })
    ),
    // Category
    el('div', { class: 'form-group' },
      el('label', {}, 'Categoria'),
      el('div', { class: 'chip-row' },
        ...['romantic', 'family', 'survival', 'alphabet', 'numbers', 'vocab', 'countries', 'verbs', 'custom'].map(cat =>
          el('button', {
            class: `chip ${category === cat ? 'active' : ''}`,
            dataset: { cat },
            onclick: (e) => {
              $$('.chip-row .chip').forEach(c => c.classList.remove('active'));
              e.currentTarget.classList.add('active');
              categoryInput.value = cat;
            }
          }, categoryLabel(cat))
        )
      ),
      el('input', { type: 'hidden', id: '_cat', value: category })
    ),
    // Front (Portuguese or Russian depending on type)
    el('div', { class: 'form-group' },
      el('label', { id: 'label-front' }, type === 'letter' ? 'Frente (letra cirílica)' : 'Frente (português)'),
      el('input', { class: `input ${type === 'letter' ? 'russian' : ''}`, id: 'input-front', placeholder: type === 'letter' ? 'Ex.: А а' : 'Ex.: Eu te amo', value: frontText })
    ),
    // Back (Russian)
    el('div', { class: 'form-group' },
      el('label', {}, type === 'letter' ? 'Verso (som / exemplo)' : 'Verso (russo — cirílico)'),
      el('input', { class: 'input russian', id: 'input-back', placeholder: 'Ex.: Я тебя люблю', value: backText })
    ),
    // Transliteration
    el('div', { class: 'form-group' },
      el('label', {}, 'Transliteração (opcional)'),
      el('input', { class: 'input', id: 'input-translit', placeholder: 'Ex.: Ya tibiá liubliú', value: translit })
    ),
    // Note
    el('div', { class: 'form-group' },
      el('label', {}, 'Nota (opcional — contexto)'),
      el('textarea', { class: 'textarea', id: 'input-note', placeholder: 'Ex.: ela disse isso quando…' }, note)
    ),
    // Voice recording
    el('div', { class: 'form-group', id: 'rec-group' }),
    // Actions
    el('div', { class: 'row mt-2' },
      editing && el('button', { class: 'btn btn-danger', onclick: () => deleteCard(editing.id) }, 'Excluir'),
      el('button', { class: 'btn btn-ghost flex-grow', onclick: () => { editingCardId = null; showView('dashboard'); } }, 'Cancelar'),
      el('button', { class: 'btn flex-grow', onclick: () => saveCard(editing) }, editing ? 'Salvar' : 'Adicionar')
    )
  );
  root.appendChild(form);

  // Wire hidden fields
  const typeInput = $('#_type', form);
  const categoryInput = $('#_cat', form);
  function updateTypeUI(t) {
    $('#label-front', form).textContent = t === 'letter' ? 'Frente (letra cirílica)' : 'Frente (português)';
    $('#input-front', form).classList.toggle('russian', t === 'letter');
    $('#input-front', form).placeholder = t === 'letter' ? 'Ex.: А а' : 'Ex.: Eu te amo';
    // Update seg active state
    const segButtons = $$('.seg button', form);
    segButtons[0].classList.toggle('active', t === 'phrase');
    segButtons[1].classList.toggle('active', t === 'letter');
  }

  // Recording UI
  renderRecControl(editing?.id, $('#rec-group', form));
}

function renderRecControl(cardId, host) {
  host.innerHTML = '';
  host.appendChild(el('label', {}, 'Áudio dela (opcional)'));
  if (!recorder.supported()) {
    host.appendChild(el('div', { class: 'small muted' }, 'Seu navegador não suporta gravação.'));
    return;
  }
  const row = el('div', { class: 'row' });
  let recBtn, playBtn, deleteBtn;
  recBtn = el('button', { class: 'rec-btn', onclick: () => toggleRec() },
    el('span', { class: 'rec-dot' }), el('span', { id: 'rec-label' }, 'Gravar'));
  row.appendChild(recBtn);

  async function refresh() {
    const existing = cardId ? await DB.get('audio', cardId) : null;
    if (existing?.blob) {
      if (!playBtn) {
        playBtn = el('button', { class: 'rec-btn', onclick: () => playBlob(existing.blob) }, '▶ Ouvir');
        row.appendChild(playBtn);
      }
      if (!deleteBtn) {
        deleteBtn = el('button', { class: 'rec-btn', onclick: async () => {
          await DB.delete('audio', cardId);
          deleteBtn.remove(); playBtn.remove(); playBtn = null; deleteBtn = null;
        } }, '✕ Remover');
        row.appendChild(deleteBtn);
      }
    }
  }

  async function toggleRec() {
    if (!recorder.isRecording()) {
      try {
        await recorder.start();
        recBtn.classList.add('recording');
        $('#rec-label', recBtn).textContent = 'Parar';
      } catch (err) {
        toast('Permita acesso ao microfone.');
      }
    } else {
      const blob = await recorder.stop();
      recBtn.classList.remove('recording');
      $('#rec-label', recBtn).textContent = 'Gravar';
      if (blob && cardId) {
        await DB.put('audio', { cardId, blob, createdAt: Date.now() });
        toast('Gravação salva.');
        refresh();
      } else if (blob) {
        // Will be saved after card save
        pendingAudioBlob = blob;
        toast('Gravado — será salvo com a carta.');
      }
    }
  }
  host.appendChild(row);
  refresh();
}
let pendingAudioBlob = null;

async function saveCard(editing) {
  const type = $('#_type').value;
  const category = $('#_cat').value;
  const frontText = $('#input-front').value.trim();
  const backText = $('#input-back').value.trim();
  const translit = $('#input-translit').value.trim();
  const note = $('#input-note').value.trim();
  if (!frontText || !backText) { toast('Frente e verso são obrigatórios.'); return; }

  const card = editing || {
    id: uid('C'),
    type, category,
    front: { text: '', language: '' },
    back: { text: '', language: '' },
    createdBy: 'user',
    createdAt: Date.now()
  };
  card.type = type;
  card.category = category;
  card.front = { text: frontText, language: type === 'letter' ? 'ru' : 'pt' };
  card.back = {
    text: backText,
    language: 'ru',
    transliteration: translit || undefined,
    note: note || undefined
  };

  await DB.put('cards', card);
  // Update in-memory
  const idx = state.cards.findIndex(c => c.id === card.id);
  if (idx >= 0) state.cards[idx] = card; else state.cards.push(card);

  if (pendingAudioBlob) {
    await DB.put('audio', { cardId: card.id, blob: pendingAudioBlob, createdAt: Date.now() });
    pendingAudioBlob = null;
  }
  editingCardId = null;
  toast(editing ? 'Carta atualizada.' : 'Carta adicionada.');
  showView('browse');
}

async function deleteCard(id) {
  if (!confirm('Excluir esta carta? Não dá para desfazer.')) return;
  await DB.delete('cards', id);
  await DB.delete('progress', id);
  await DB.delete('audio', id);
  state.cards = state.cards.filter(c => c.id !== id);
  delete state.progress[id];
  editingCardId = null;
  toast('Carta excluída.');
  showView('browse');
}

/* ---------- Browse ---------- */
const browseState = { filter: 'all', query: '' };

function renderBrowse() {
  const root = $('#view-browse');
  root.innerHTML = '';
  const search = el('div', { class: 'search' },
    el('input', {
      class: 'input', placeholder: 'Buscar… (pt ou ru)', value: browseState.query,
      oninput: (e) => { browseState.query = e.target.value; renderBrowseList(); }
    }),
    el('div', { class: 'chip-row mt-1' },
      ...['all', 'alphabet', 'romantic', 'family', 'survival', 'numbers', 'vocab', 'countries', 'verbs', 'custom', 'due'].map(f =>
        el('button', {
          class: `chip ${browseState.filter === f ? 'active' : ''}`,
          onclick: () => { browseState.filter = f; renderBrowse(); }
        }, f === 'all' ? 'todas' : f === 'due' ? 'a revisar' : categoryLabel(f))
      )
    )
  );
  root.appendChild(search);
  const list = el('div', { class: 'list', id: 'browse-list' });
  root.appendChild(list);
  renderBrowseList();
}

function renderBrowseList() {
  const list = $('#browse-list'); if (!list) return;
  list.innerHTML = '';
  const q = browseState.query.trim().toLowerCase();
  const now = Date.now();
  const filtered = state.cards.filter(c => {
    if (browseState.filter === 'due') {
      const p = state.progress[c.id];
      return p && p.repetitions > 0 && p.dueDate <= now;
    }
    if (browseState.filter !== 'all' && c.category !== browseState.filter) return false;
    if (q) {
      const bag = [c.front?.text, c.back?.text, c.back?.transliteration, c.back?.note].filter(Boolean).join(' ').toLowerCase();
      if (!bag.includes(q)) return false;
    }
    return true;
  });
  if (!filtered.length) {
    list.appendChild(el('div', { class: 'empty' }, 'Nenhuma carta.'));
    return;
  }
  for (const c of filtered) {
    const p = state.progress[c.id];
    const badge = !p || p.repetitions === 0
      ? el('span', { class: 'badge new' }, 'nova')
      : p.dueDate <= now
        ? el('span', { class: 'badge due' }, 'revisar')
        : isMastered(p)
          ? el('span', { class: 'badge ok' }, 'dominada')
          : el('span', { class: 'badge' }, 'aprendendo');
    list.appendChild(el('button', {
      class: 'list-item',
      onclick: () => { editingCardId = c.id; showView('add'); }
    },
      el('div', {},
        el('div', { class: 'li-front' }, c.front?.text || ''),
        el('div', { class: 'li-back' }, c.back?.text || '')
      ),
      el('div', { class: 'li-meta' }, badge, el('div', { class: 'small muted mt-1' }, categoryLabel(c.category)))
    ));
  }
}

/* ---------- Settings ---------- */
function renderSettings() {
  const root = $('#view-settings');
  root.innerHTML = '';

  const card = el('div', { class: 'card' },
    el('h2', {}, 'Sessão'),
    // New cards per day (letters + phrases combined)
    el('div', { class: 'setting-row' },
      el('div', {},
        el('div', { class: 'setting-label' }, 'Cartas novas por dia'),
        el('div', { class: 'setting-hint' }, 'Quantas cartas inéditas você quer ver por dia. Revisões aparecem por cima, no ritmo do SRS.')
      ),
      el('div', { class: 'row' },
        el('input', {
          type: 'range', class: 'slider', min: '0', max: '40', step: '1',
          value: String(state.settings.newCardsPerDay),
          oninput: (e) => { $('#v-new').textContent = e.target.value; },
          onchange: async (e) => { await setSetting('newCardsPerDay', Number(e.target.value)); }
        }),
        el('div', { id: 'v-new', class: 'small muted' }, String(state.settings.newCardsPerDay))
      )
    ),
    // Phrase direction (which side shows on the front)
    el('div', { class: 'setting-row' },
      el('div', {},
        el('div', { class: 'setting-label' }, 'Direção das frases'),
        el('div', { class: 'setting-hint' }, 'Em qual idioma você vê a frente — e qual idioma adivinha.')
      ),
      el('div', { class: 'seg' },
        el('button', {
          class: state.settings.phraseDirection === 'ru-to-pt' ? 'active' : '',
          onclick: async () => { await setSetting('phraseDirection', 'ru-to-pt'); renderSettings(); }
        }, 'Cirílico → PT'),
        el('button', {
          class: state.settings.phraseDirection === 'pt-to-ru' ? 'active' : '',
          onclick: async () => { await setSetting('phraseDirection', 'pt-to-ru'); renderSettings(); }
        }, 'PT → Cirílico')
      )
    ),
    // Review cap
    el('div', { class: 'setting-row' },
      el('div', {},
        el('div', { class: 'setting-label' }, 'Limite de revisões'),
        el('div', { class: 'setting-hint' }, 'Máximo de cartas a revisar por sessão')
      ),
      el('div', { class: 'row' },
        el('input', {
          type: 'range', class: 'slider', min: '10', max: '200', step: '5',
          value: String(state.settings.reviewCap),
          oninput: (e) => { $('#v-cap').textContent = e.target.value; },
          onchange: async (e) => { await setSetting('reviewCap', Number(e.target.value)); }
        }),
        el('div', { id: 'v-cap', class: 'small muted' }, String(state.settings.reviewCap))
      )
    ),
    // Theme
    el('div', { class: 'setting-row' },
      el('div', { class: 'setting-label' }, 'Tema'),
      el('div', { class: 'seg' },
        ...['auto', 'light', 'dark'].map(t =>
          el('button', {
            class: state.settings.theme === t ? 'active' : '',
            onclick: async () => { await setSetting('theme', t); applyTheme(); renderSettings(); }
          }, t === 'auto' ? 'Auto' : t === 'light' ? 'Claro' : 'Escuro')
        )
      )
    ),
    // Preferred voice
    el('div', { class: 'setting-row' },
      el('div', {},
        el('div', { class: 'setting-label' }, 'Voz preferida'),
        el('div', { class: 'setting-hint' }, 'Quando existir gravação dela, usar qual?')
      ),
      el('div', { class: 'seg' },
        el('button', {
          class: state.settings.preferredVoice === 'recorded' ? 'active' : '',
          onclick: async () => { await setSetting('preferredVoice', 'recorded'); renderSettings(); }
        }, 'Gravada'),
        el('button', {
          class: state.settings.preferredVoice === 'tts' ? 'active' : '',
          onclick: async () => { await setSetting('preferredVoice', 'tts'); renderSettings(); }
        }, 'TTS')
      )
    )
  );
  root.appendChild(card);

  // Data card
  const dataCard = el('div', { class: 'card' },
    el('h2', {}, 'Dados'),
    el('p', { class: 'small muted mb-1' },
      `Seus dados vivem só aqui no seu aparelho. Nada sobe para nenhum servidor. Faça backups de vez em quando.`),
    el('div', { class: 'row' },
      el('button', { class: 'btn btn-ghost flex-grow', onclick: exportData }, 'Exportar backup'),
      el('button', { class: 'btn btn-ghost flex-grow', onclick: () => $('#file-import').click() }, 'Importar backup')
    ),
    el('div', { class: 'row mt-2' },
      el('button', { class: 'btn btn-ghost flex-grow', onclick: reloadStarter }, 'Recarregar deck inicial'),
      el('button', { class: 'btn btn-danger flex-grow', onclick: resetProgress }, 'Zerar progresso')
    )
  );
  root.appendChild(dataCard);

  // About
  const about = el('div', { class: 'card center muted small' },
    el('div', { style: 'font-family: var(--font-serif); font-size: 40px; color: var(--accent); margin-bottom: 8px;' }, 'Я'),
    el('div', {}, 'Азбука — Your Cyrillic Companion'),
    el('div', { class: 'mt-1' }, 'v1.0 · feito com carinho · sem tracking, sem contas')
  );
  root.appendChild(about);
}

/* ---------- Theme ---------- */
function applyTheme() {
  document.body.dataset.theme = state.settings.theme || 'auto';
  const isDark = (state.settings.theme === 'dark') ||
                 (state.settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
    m.setAttribute('content', isDark ? '#1a1440' : '#fdf6e3');
  });
}

/* ---------- Export / Import ---------- */
async function blobToBase64(blob) {
  return await new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
async function base64ToBlob(dataUrl) {
  const r = await fetch(dataUrl); return await r.blob();
}

async function exportData() {
  const cards = await DB.getAll('cards');
  const progress = await DB.getAll('progress');
  const audio = await DB.getAll('audio');
  const settings = {};
  for (const k of Object.keys(DEFAULTS)) settings[k] = state.settings[k];

  const audioOut = [];
  for (const a of audio) {
    try { audioOut.push({ cardId: a.cardId, dataUrl: await blobToBase64(a.blob), createdAt: a.createdAt || Date.now() }); }
    catch {}
  }

  const payload = {
    format: 'azbuka-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings, cards, progress, audio: audioOut
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `azbuka-backup-${todayStr()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('Backup exportado.');
  await setSetting('backupReminder', Date.now());
}

async function importData(file) {
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (payload.format !== 'azbuka-backup') { toast('Arquivo inválido.'); return; }
    if (!confirm('Substituir seus dados pelo conteúdo do backup?')) return;

    await DB.clear('cards'); await DB.clear('progress'); await DB.clear('audio');
    if (payload.cards?.length) await DB.bulkPut('cards', payload.cards);
    if (payload.progress?.length) await DB.bulkPut('progress', payload.progress);
    if (payload.audio?.length) {
      for (const a of payload.audio) {
        try {
          const blob = await base64ToBlob(a.dataUrl);
          await DB.put('audio', { cardId: a.cardId, blob, createdAt: a.createdAt });
        } catch {}
      }
    }
    if (payload.settings) {
      for (const [k, v] of Object.entries(payload.settings)) await setSetting(k, v);
    }
    toast('Backup importado.');
    await boot(true);
  } catch (err) {
    console.error(err);
    toast('Não foi possível importar.');
  }
}

async function reloadStarter() {
  if (!confirm('Recarregar o deck inicial? Cartas pessoais são preservadas.')) return;
  const existingIds = new Set(state.cards.filter(c => c.createdBy === 'seed').map(c => c.id));
  const json = await fetch('starter-cards.json', { cache: 'no-cache' }).then(r => r.json());
  const put = [];
  for (const c of json.cards) put.push({ ...c, createdBy: 'seed', createdAt: Date.now() });
  await DB.bulkPut('cards', put);
  // Reload in-memory
  state.cards = await DB.getAll('cards');
  toast(`${json.cards.length} cartas recarregadas.`);
  renderDashboard();
}

async function resetProgress() {
  if (!confirm('Zerar TODO o progresso (cartas preservadas)?')) return;
  await DB.clear('progress');
  state.progress = {};
  await setSetting('streak', 0);
  await setSetting('lastSessionDate', null);
  toast('Progresso zerado.');
  renderDashboard();
}

/* ---------- Boot ---------- */
async function boot(skipStarter = false) {
  state.settings = await loadSettings();
  applyTheme();

  // One-shot migration: legacy scheduling capped phrases at 1 per N days. The unified-budget
  // scheduler treats `newCardsPerDay` as a combined letters+phrases budget, so legacy users on
  // the old 8-letters-only default need a bump to actually see the new decks.
  if (!state.settings.schedulingV2) {
    if ((state.settings.newCardsPerDay || 0) <= 8) {
      await setSetting('newCardsPerDay', 20);
    }
    await setSetting('schedulingV2', true);
  }

  if (!skipStarter) {
    try {
      const res = await fetch('starter-cards.json', { cache: 'no-cache' });
      const json = await res.json();
      const remoteVersion = json.version || 1;
      const localVersion = state.settings.starterVersion || 0;
      if (remoteVersion > localVersion) {
        // Upsert (bulkPut, not clear) — preserves custom cards and existing progress.
        const existing = await DB.getAll('cards');
        const existingIds = new Set(existing.map(c => c.id));
        const now = Date.now();
        const upsert = json.cards.map(c => ({
          ...c,
          createdBy: 'seed',
          createdAt: existingIds.has(c.id) ? (existing.find(x => x.id === c.id)?.createdAt || now) : now
        }));
        await DB.bulkPut('cards', upsert);
        await setSetting('starterVersion', remoteVersion);
        if (localVersion > 0) toast(`Deck atualizado para v${remoteVersion}.`);
      }
    } catch (err) {
      console.error('Failed to load starter deck', err);
      if (!state.settings.starterVersion) toast('Abra o app com um servidor local (file:// não funciona).');
    }
  }

  state.cards = await DB.getAll('cards');
  const progressArr = await DB.getAll('progress');
  state.progress = Object.fromEntries(progressArr.map(p => [p.cardId, p]));

  await loadReading();

  TTS.init();

  // Reveal app
  $('#splash').classList.add('hide');
  setTimeout(() => { $('#splash').remove?.(); }, 260);
  $('#topbar').hidden = false;
  $('#main').hidden = false;
  $('#tabbar').hidden = false;

  showView('dashboard');

  // Periodic backup nudge (every ~30 days)
  const since = Date.now() - (state.settings.backupReminder || 0);
  if (state.cards.some(c => c.createdBy === 'user') && since > 30 * 86400000) {
    setTimeout(() => toast('Hora de exportar um backup — Ajustes › Dados.'), 1500);
  }
}

/* ---------- Event wiring ---------- */
function wireChrome() {
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      if (name === 'add') editingCardId = null;
      if (name === 'study' && !state.session && countsForToday().sessionSize > 0) {
        return startSession();
      }
      showView(name);
    });
  }
  $('#btn-settings').addEventListener('click', () => showView('settings'));
  $('#file-import').addEventListener('change', (e) => {
    const f = e.target.files?.[0]; if (f) importData(f);
    e.target.value = '';
  });
  // React to OS theme changes while 'auto'
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (state.settings.theme === 'auto') applyTheme();
  });
}

// Service worker registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW failed', err));
  });
}

document.addEventListener('DOMContentLoaded', () => {
  wireChrome();
  boot().catch(err => {
    console.error(err);
    $('#splash .splash-sub').textContent = 'erro — recarregue';
  });
});
