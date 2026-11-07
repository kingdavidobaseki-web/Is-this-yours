require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-3.8-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Keep requests small enough to stay comfortably inside Groq's free rate
// limits and avoid a single oversized payload timing out.
const MAX_SENTENCES = 120;
const MAX_CHARS_PER_SENTENCE = 600;

// Images arrive as base64 data URLs, which run noticeably bigger than
// the raw file — 10mb comfortably covers a typical phone photo.
app.use(express.json({ limit: '10mb' }));

// Serve the three frontend files directly from the repo root — no
// subfolder needed, so no slash to type or mistype when creating files
// through GitHub's mobile web upload.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));

const OWNER_KEY = process.env.OWNER_KEY;

const HUMANIZE_SYSTEM_PROMPT = `You are a ghostwriter rewriting AI-drafted prose so it reads like one specific, slightly imperfect human author wrote it on deadline — not polished, not symmetrical, not safe.

Follow these rules exactly:

1. Vary sentence length aggressively. Never let three sentences in a row run the same length or rhythm. Follow a long sentence with a short one, or a fragment.

2. Never open two sentences in the same paragraph with the same word or the same grammatical construction. No repeated "He didn't... / She didn't..." patterns. No repeated "[Name] [verb]ed" openers back to back.

3. Cut any line that explains a character's emotion directly ("she felt sad", "he was relieved"). Show it through one concrete action or one piece of blunt dialogue instead.

4. Delete clever or compressed similes and metaphors ("like a wound that never closed"). If a comparison is truly needed, make it plain and almost too simple — not literary.

5. Make dialogue sound like real interrupted speech: people talk over each other, trail off, answer the wrong question, don't finish sentences. No character delivers a tidy, quotable "thesis statement" line.

6. Cut aphoristic one-liners entirely ("Money is never free." "Silence can be louder than words."). If a sentence sounds like it belongs on a poster, make it blunter and less symmetrical, or cut it.

7. Use plain, everyday vocabulary — nothing a careful ordinary writer wouldn't reach for. No thesaurus words.

8. Small imperfection is good: a sentence that trails off, a one-line paragraph, slightly uneven pacing.

9. No formulaic transitions ("Meanwhile," "Little did she know," "As the sun set over...").

10. Keep paragraphs short and uneven in length, not uniform blocks.

