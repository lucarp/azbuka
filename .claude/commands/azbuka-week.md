---
description: Generate next week's daily reading paragraphs for the Azbuka PWA, commit to main.
---

Generate the next week of daily reading paragraphs for the Azbuka PWA and ship them to main.

## Repo

Work in this repo (`lucarp/azbuka`). The current ISO week's bundle (and earlier ones) live in `paragraphs/`.

## What to produce

A new file `paragraphs/<weekId>.json` for the **next** ISO week (the week starting the upcoming Monday — not this week). Update `paragraphs/index.json` to register it. Commit and push to `main`.

Schema (validate against the existing files in `paragraphs/`):

```jsonc
{
  "format": "azbuka-paragraphs-week",
  "version": 1,
  "week": "YYYY-WNN",                // ISO week id (e.g. 2026-W20)
  "startDate": "YYYY-MM-DD",         // Monday
  "endDate": "YYYY-MM-DD",           // Sunday
  "generatedAt": "ISO-8601",
  "coreVocab": [
    { "ru": "...", "pt": "...", "note": "gênero/forma/uso" }
    // 8–10 anchor words that appear multiple times across the week's paragraphs
  ],
  "days": [
    {
      "date": "YYYY-MM-DD",
      "kind": "news" | "story",
      "title": "Russian title",
      "ru": "4 short sentences in simple Russian.",
      "pt": "Tradução natural ao português brasileiro.",
      "transliteration": "Stress-marked transliteration (Portuguese-flavored, see existing files).",
      "notes": [
        { "ru": "palavra", "pt": "tradução", "note": "explicação curta da forma/caso/conjugação" }
        // 6–9 entries per day, prioritizing words that aren't trivially obvious to a beginner
      ]
    }
    // exactly 7 days, Mon → Sun
  ]
}
```

## Content rules

- **Audience:** absolute beginner Brazilian-Portuguese speaker learning Russian (A0–A1, just past the Cyrillic alphabet).
- **Length:** 4 sentences per paragraph, ~30–50 Russian words.
- **Verbs:** present tense, 3rd person preferred. Avoid past tense and aspectual pairs unless trivial. Avoid imperatives.
- **Vocabulary spiral:** read the previous week's `coreVocab` (last file in `paragraphs/`). Roll **~70% forward** into the new week's `coreVocab` (replace the rest). At least 2–3 words from `coreVocab` should appear in each day's paragraph.
- **Mix:** 4 news + 3 stories. Stories rotate Russian folktales (Колобок, Репка, Теремок, Маша и Медведь, Курочка Ряба, etc., **simplified**) and short original "slice of life" pieces.
- **News:** WebSearch a few international headlines from BBC/CNN/Reuters from the past week (sport, science, environment, culture, tech). **Simplify aggressively** to A0/A1 — strip names, numbers, jargon. The point is comprehensible Russian, not faithful reporting.
- **Glossary notes:** call out gender (m/f/n), case (when departing from nominative), and 3rd-person conjugations. One short sentence per `note`. Match the explanatory voice of existing files.
- **No** politics, war coverage, violent crime, or anything heavy — this is gentle daily input.

## Process

1. **Fetch state:** read `paragraphs/index.json` and the most recent week file. Note its `coreVocab`.
2. **Compute next week:** find the upcoming Monday and the ISO week id (`YYYY-WNN`).
3. **Source news:** WebSearch BBC/Reuters/etc. for 4 simple international stories (sport result, science discovery, cultural event, weather/travel). Pick stories you can rewrite into 4 simple sentences.
4. **Draft 7 days:** mix 4 news + 3 stories, alternating where reasonable. Verify each paragraph is grammatically correct Russian — re-read aloud mentally, watch case agreement, animacy in accusative, soft signs.
5. **Build coreVocab:** ~10 anchor words. ~70% reused from last week's list, ~30% new. Each appears in 2+ days.
6. **Write the file** at `paragraphs/<weekId>.json` and add an entry to `paragraphs/index.json` (`{ "id", "startDate", "endDate", "file" }`).
7. **Validate:** `python3 -c "import json; json.load(open('paragraphs/<weekId>.json')); json.load(open('paragraphs/index.json'))"`. Sanity-check that every day has 4 sentences, transliteration matches the cyrillic, glossary lengths are 6–9.
8. **Commit on main:** `git add paragraphs/`, commit with a short subject like `paragraphs: add <weekId> bundle (4 news + 3 stories)`. Push to `origin main`.

## Tone of glossary notes

Match this voice (from `2026-W19.json`):

- "Verbo учить, 3ª pessoa singular. Pede acusativo."
- "Locativo de океан (m). Termina em -е."
- "Após много, o substantivo vai para o genitivo plural."

Compact, factual, beginner-respectful. Portuguese explanations, Russian examples.

## On failure

- If WebSearch is unavailable, use generic universal themes (sport, weather, animals, cooking, travel) instead of dated news. Don't stall.
- If the previous week's file can't be read, start `coreVocab` fresh from this list: город, большой, маленький, люди, идёт, работает, живёт, смотрит, говорит, учит.
- If the push is blocked, leave the commit local and surface the issue.
