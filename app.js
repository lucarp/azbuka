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
  newCardsPerDay: 8,           // applies to LETTER cards
  reviewCap: 40,
  phraseCadenceDays: 3,        // introduce 1 new phrase every N days
  lastNewPhraseDate: null,     // yyyy-mm-dd of most recent new-phrase introduction
  theme: 'auto',
  preferredVoice: 'recorded',
  starterVersion: 0,
  lastSessionDate: null,
  streak: 0,
  backupReminder: Date.now()
};

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
  playingAudioEl: null
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
  return { alphabet: 'alfabeto', romantic: 'romance', family: 'família', survival: 'sobrevivência', custom: 'pessoal' }[c] || c;
}

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const last = new Date(`${dateStr}T00:00:00`);
  const today = new Date(`${todayStr()}T00:00:00`);
  return Math.floor((today - last) / 86400000);
}
function canIntroduceNewPhraseToday() {
  const cadence = state.settings.phraseCadenceDays || 3;
  return daysSince(state.settings.lastNewPhraseDate) >= cadence;
}

function countsForToday() {
  const now = Date.now();
  let dueLetters = 0, freshLetters = 0;
  let duePhrases = 0, freshPhrases = 0;
  let mastered = 0;
  for (const c of state.cards) {
    const p = state.progress[c.id];
    const isNew = !p || p.repetitions === 0;
    const isDue = p && p.repetitions > 0 && p.dueDate <= now;
    if (c.type === 'letter') {
      if (isNew) freshLetters++;
      else if (isDue) dueLetters++;
    } else {
      if (isNew) freshPhrases++;
      else if (isDue) duePhrases++;
    }
    if (p && p.interval >= 14) mastered++;
  }
  const newLettersToday = Math.min(freshLetters, state.settings.newCardsPerDay);
  const dueLettersToday = Math.min(dueLetters, state.settings.reviewCap);
  const newPhraseToday = canIntroduceNewPhraseToday() ? Math.min(freshPhrases, 1) : 0;
  const duePhrasesToday = Math.min(duePhrases, state.settings.reviewCap);
  const sessionSize = newLettersToday + dueLettersToday + newPhraseToday + duePhrasesToday;
  return {
    dueLetters, freshLetters, duePhrases, freshPhrases,
    newLettersToday, dueLettersToday, newPhraseToday, duePhrasesToday,
    sessionSize,
    total: state.cards.length,
    mastered
  };
}

function planSession() {
  const now = Date.now();
  const letters = state.cards.filter(c => c.type === 'letter');
  const phrases = state.cards.filter(c => c.type !== 'letter');

  const dueLetters = letters
    .filter(c => { const p = state.progress[c.id]; return p && p.repetitions > 0 && p.dueDate <= now; })
    .sort((a, b) => state.progress[a.id].dueDate - state.progress[b.id].dueDate)
    .slice(0, state.settings.reviewCap);

  const duePhrases = phrases
    .filter(c => { const p = state.progress[c.id]; return p && p.repetitions > 0 && p.dueDate <= now; })
    .sort((a, b) => state.progress[a.id].dueDate - state.progress[b.id].dueDate)
    .slice(0, state.settings.reviewCap);

  const freshLetters = letters
    .filter(c => { const p = state.progress[c.id]; return !p || p.repetitions === 0; })
    .slice(0, state.settings.newCardsPerDay);

  const freshPhrase = canIntroduceNewPhraseToday()
    ? phrases.filter(c => { const p = state.progress[c.id]; return !p || p.repetitions === 0; }).slice(0, 1)
    : [];

  // Review first (builds confidence), then new material. Letters prioritised.
  return [...dueLetters, ...duePhrases, ...freshLetters, ...freshPhrase];
}

function isMastered(p) { return p && p.interval >= 14; }

/* ---------- Router ---------- */
function showView(name) {
  state.currentTab = name;
  const titles = { dashboard: 'Азбука', study: 'Estudo', add: 'Nova carta', browse: 'Cartas', settings: 'Ajustes' };
  $('#topbar-title').textContent = titles[name] || 'Азбука';
  for (const v of $$('.view')) v.hidden = v.id !== `view-${name}`;
  for (const t of $$('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  // Render current view fresh on every navigation
  const renderers = {
    dashboard: renderDashboard,
    study: renderStudyHome,
    add: renderAdd,
    browse: renderBrowse,
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
  if (counts.newLettersToday) bits.push(`${counts.newLettersToday} letra${counts.newLettersToday > 1 ? 's' : ''} nova${counts.newLettersToday > 1 ? 's' : ''}`);
  if (counts.dueLettersToday) bits.push(`${counts.dueLettersToday} revisão${counts.dueLettersToday > 1 ? 'ões' : ''}`);
  if (counts.duePhrasesToday) bits.push(`${counts.duePhrasesToday} frase${counts.duePhrasesToday > 1 ? 's' : ''} (revisão)`);
  if (counts.newPhraseToday) bits.push('1 frase nova');
  const phraseWaitDays = (state.settings.phraseCadenceDays || 3) - daysSince(state.settings.lastNewPhraseDate);
  const phraseNote = counts.newPhraseToday === 0 && counts.freshPhrases > 0 && phraseWaitDays > 0
    ? `Próxima frase nova em ${phraseWaitDays} dia${phraseWaitDays > 1 ? 's' : ''}.`
    : null;

  const hero = el('div', { class: 'hero' },
    el('div', { class: 'hero-label' }, 'Hoje'),
    el('div', { class: 'hero-count' }, String(counts.sessionSize)),
    el('div', { class: 'hero-sub' },
      counts.sessionSize === 0
        ? (phraseNote || 'Nenhuma carta pendente. Volte mais tarde.')
        : bits.join(' · ')
    ),
    el('button', {
      class: 'hero-cta',
      disabled: counts.sessionSize === 0,
      onclick: () => startSession()
    }, counts.sessionSize === 0 ? 'Tudo em dia ✓' : 'Estudar agora')
  );
  root.appendChild(hero);
  if (counts.sessionSize > 0 && phraseNote) {
    root.appendChild(el('div', { class: 'muted small center', style: 'margin-top:-6px; margin-bottom:14px;' }, phraseNote));
  }

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
    root.appendChild(el('h3', { class: 'mt-2' }, 'Alfabeto cirílico'));
    const grid = el('div', { class: 'alpha-grid' });
    for (const card of letters) {
      const p = state.progress[card.id];
      const cls = p && isMastered(p) ? 'alpha-cell mastered'
                 : p && p.repetitions > 0 ? 'alpha-cell learning'
                 : 'alpha-cell';
      const label = card.front.text.trim().split(/\s+/)[0]; // uppercase
      grid.appendChild(el('button', {
        class: cls,
        onclick: () => quickPlay(card)
      }, label));
    }
    root.appendChild(grid);
  }

  // Quick tips
  if (counts.total < 10) {
    root.appendChild(el('div', { class: 'card mt-2 center muted small' },
      'Dica: o baralho inicial tem 78 cartas. Se você vê poucas, reimporte pelos ajustes.'
    ));
  }
}

function quickPlay(card) {
  const text = russianAudioText(card);
  if (text) TTS.speak(text);
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
      const ruText = russianAudioText(card);
      if (ruText) playCardAudio(card, ruText);
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

function russianAudioText(card) {
  // For letter cards, play the example word — it carries the sound in context.
  if (card.type === 'letter' && card.example?.ru) return card.example.ru;
  if (card.back?.language === 'ru') return card.back.text;
  if (card.front?.language === 'ru') return card.front.text;
  return null;
}

function renderFront(card) {
  const face = el('div', { class: 'face face-front' });
  const isLetter = card.type === 'letter';
  face.appendChild(el('div', { class: `front-text ${isLetter ? 'letter' : 'phrase'}` }, card.front.text));
  if (isLetter && card.example?.ru) {
    face.appendChild(el('div', { class: 'front-example' }, card.example.ru));
  }
  return face;
}

function renderBack(card) {
  const face = el('div', { class: 'face face-back' });
  const isLetter = card.type === 'letter';

  // Main label (letter name or phrase translation)
  face.appendChild(el('div', { class: `back-main ${isLetter ? 'letter' : ''}` }, card.back.text));

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
  const ruText = russianAudioText(card);
  if (ruText) {
    row.appendChild(el('button', {
      class: 'btn-audio',
      onclick: (ev) => { ev.stopPropagation(); TTS.speak(ruText); }
    }, '♪ Ouvir'));
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

function playCardAudio(card, ruText) {
  // Honor preferred voice
  DB.get('audio', card.id).then(rec => {
    if (rec?.blob && state.settings.preferredVoice === 'recorded') {
      playBlob(rec.blob);
    } else {
      TTS.speak(ruText);
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
  const wasFirstSightOfPhrase = card.type !== 'letter' && prev.repetitions === 0;
  const next = sm2(prev, quality);
  state.progress[card.id] = next;
  await DB.put('progress', next);
  if (wasFirstSightOfPhrase) {
    await setSetting('lastNewPhraseDate', todayStr());
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
        ...['romantic', 'family', 'survival', 'alphabet', 'custom'].map(cat =>
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
      ...['all', 'alphabet', 'romantic', 'family', 'survival', 'custom', 'due'].map(f =>
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
    // New letters per day
    el('div', { class: 'setting-row' },
      el('div', {},
        el('div', { class: 'setting-label' }, 'Letras novas por dia'),
        el('div', { class: 'setting-hint' }, 'Quantas letras inéditas a cada dia')
      ),
      el('div', { class: 'row' },
        el('input', {
          type: 'range', class: 'slider', min: '0', max: '15', step: '1',
          value: String(state.settings.newCardsPerDay),
          oninput: (e) => { $('#v-new').textContent = e.target.value; },
          onchange: async (e) => { await setSetting('newCardsPerDay', Number(e.target.value)); }
        }),
        el('div', { id: 'v-new', class: 'small muted' }, String(state.settings.newCardsPerDay))
      )
    ),
    // Phrase cadence
    el('div', { class: 'setting-row' },
      el('div', {},
        el('div', { class: 'setting-label' }, 'Frase nova a cada'),
        el('div', { class: 'setting-hint' }, '1 frase inédita neste intervalo; revisões continuam normais')
      ),
      el('div', { class: 'row' },
        el('input', {
          type: 'range', class: 'slider', min: '1', max: '14', step: '1',
          value: String(state.settings.phraseCadenceDays),
          oninput: (e) => { $('#v-cad').textContent = e.target.value + ' dia' + (e.target.value === '1' ? '' : 's'); },
          onchange: async (e) => { await setSetting('phraseCadenceDays', Number(e.target.value)); }
        }),
        el('div', { id: 'v-cad', class: 'small muted' },
          `${state.settings.phraseCadenceDays} dia${state.settings.phraseCadenceDays === 1 ? '' : 's'}`)
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
