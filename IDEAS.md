# IDEAS — Phase 3 and beyond

_A list of ideas that are **not** on the main track, on purpose. Nothing here gets built until Phase 2 proves the app is worth keeping._

## Polish / delight
- [ ] Card flip with haptic feedback on iOS (`navigator.vibrate`).
- [ ] Difficulty heatmap on the dashboard: which letters/phrases trip the user up most (use `lapses` × recency).
- [ ] Show the context note on the back of the card, styled like a handwritten note.
- [ ] Per-category filters in the study flow: "tonight, only romantic phrases".
- [ ] Better Cyrillic typography — try a Didone or Old Standard TT fallback.
- [ ] Subtle sound on correct/incorrect in listening cards.
- [ ] "First letter" hint on the Portuguese front for phrase cards (spoiler protected).

## New card types
- [ ] **Listening card.** Audio-only → pick meaning from 4 options. (Data model already supports it; just needs a renderer + a type toggle.)
- [ ] **Typing card.** Type the phrase in Cyrillic using the iOS keyboard. Tolerant matching (ignore punctuation, case).
- [ ] **Cloze card.** Hide one word from a phrase; the user fills it. Good for grammar once the basics land.
- [ ] **Image card.** Tap a noun card, show a photo (optional `imageBlob` field) for visual recall.

## Content
- [ ] Numbers 1–100 + ordinals.
- [ ] Cases (nominative/accusative/genitive) gently, with sentence examples and highlighted endings.
- [ ] Verbs of motion (идти / ходить / ехать / ездить). The most brutally Russian topic.
- [ ] Small deck of Russian idioms/sayings the family actually uses.

## Session & stats
- [ ] Weekly summary: "these 7 days, you reviewed X, mastered Y new letters, forgot Z".
- [ ] Monthly streak summary as a tiny SVG heatmap (GitHub contribution-style).
- [ ] "Nervous words" view — the top 10 cards by lapse count.

## Delight (no pressure)
- [ ] A one-tap "send this phrase on WhatsApp" button on any phrase card — so you can actually use what you just learned.
- [ ] A shared deck format — both phones import the same file; progress merges keep her edits.
- [ ] Easter egg: on her birthday, the splash `Я` becomes a little heart.

## Tech debt to watch
- [ ] Replace the handwritten IndexedDB wrapper with `idb-keyval` if complexity grows.
- [ ] Add a CI smoke test that boots the page headless and asserts the dashboard renders.
- [ ] Audit bundle size — shouldn't creep past ~30KB gzipped for the shell.
