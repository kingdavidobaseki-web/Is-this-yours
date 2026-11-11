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
This is a style rewrite only — preserve every fact, plot point, and character detail exactly. Do not add new claims, dialogue, or events that weren't in the original. Do not change the point of view or tense.

Respond with ONLY the rewritten text. No preamble, no explanation, no quotation marks wrapping it.`;

const IMAGE_SYSTEM_PROMPT = `You are an expert at spotting AI-generated images (Midjourney, DALL-E, Stable Diffusion, Flux, and similar tools).

Look closely at the image for telltale signs: unnatural skin texture, warped or extra fingers, inconsistent lighting or shadows, garbled or nonsensical text, overly smooth or waxy surfaces, impossible reflections, asymmetric earrings/eyes/objects that should match, and backgrounds that don't quite make physical sense.

Note: this check is for AI-GENERATED images specifically, not for edited or doctored real photos/screenshots (like a faked bank balance) — that is a different kind of manipulation this check is not built to catch.

Respond with ONLY valid JSON in this exact shape, no other text:
{"aiScore": 0.0, "verdict": "short 4-8 word summary", "reasoning": "2-3 sentences explaining the specific visual evidence you saw"}

aiScore is 0-1: 0 means clearly a real photo/human-made image, 1 means clearly AI-generated.`;

app.post('/api/detect-image', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'Server is missing GEMINI_API_KEY. Add it to your .env file and restart.',
      });
    }

    const imageDataUrl = req.body && req.body.image ? String(req.body.image) : '';
    const match = imageDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Upload an image first.' });
    }
    const [, mimeType, base64Data] = match;

    const geminiBody = JSON.stringify({
      contents: [
        {
          parts: [
            { text: IMAGE_SYSTEM_PROMPT },
            { inline_data: { mime_type: mimeType, data: base64Data } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    });

    let response;
    let data;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: geminiBody,
      });
      data = await response.json();
      if (response.ok) break;
      const isOverloaded = data && data.error && /overload|high demand|503/i.test(data.error.message || '');
      if (!isOverloaded || attempt === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (!response.ok) {
      const message = data && data.error ? data.error.message || data.error : `HTTP ${response.status}`;
      throw new Error(message);
    }

    const raw = data.candidates && data.candidates[0] && data.candidates[0].content
      ? data.candidates[0].content.parts.map((p) => p.text || '').join('')
      : null;
    if (!raw) throw new Error('Empty response from model.');

    const parsed = JSON.parse(raw);
    const aiScore = Math.max(0, Math.min(1, Number(parsed.aiScore) || 0));

    res.json({
      aiScore,
      verdict: parsed.verdict || '',
      reasoning: parsed.reasoning || '',
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: `Image check failed: ${err.message}` });
  }
});

function splitIntoSentences(text) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const matches = normalized.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [];
  return matches
    .map((s) => s.trim())
        .filter((s) => s.length > 0)
    .flatMap((s) => {
      const words = s.split(/\s+/);
      if (words.length <= 40) return [s];
      const parts = [];
      for (let i = 0; i < words.length; i += 30) {
        parts.push(words.slice(i, i + 30).join(' '));
      }
      return parts;
    })
    .slice(0, MAX_SENTENCES)
  
    .map((s) =>
      s.length > MAX_CHARS_PER_SENTENCE ? s.slice(0, MAX_CHARS_PER_SENTENCE) : s
    );
}

const SYSTEM_PROMPT = `You are a strict but fair AI-text auditor, the kind of editor who has read thousands of AI outputs and also thousands of raw human drafts. The text may be fiction (such as web novel chapters), a how-to guide, a social post or chat message, or a chat-style reply, in English, Nigerian Pidgin, or a mix. It may be raw human writing, plain AI output, or AI text that someone has tried to "humanize", so look for the leftovers of that too. You will receive a numbered list of sentences from one piece of writing.

For EACH sentence, score how likely it is that an AI wrote it rather than a person. Wrongly flagging a human is as bad as missing an AI.

Judge pattern and structure, never polish or spelling:
- Clean grammar and punctuation are NOT evidence of AI.
- Plain, simple writing is NOT evidence of AI.
- Typos, run-ons and rough grammar are weak evidence of a human. A raw, unpolished draft must not be flagged just for being plain or for stating a feeling directly, because many new writers do both.
- Rough spelling and dialect do not excuse chatbot structure, stock phrases, stock vocabulary or a repeated skeleton. AI can write Pidgin and fake mistakes, so be suspicious when the mess is spread evenly instead of random.

Human voice (score these 0.15 or lower):
- direct address and attitude: "you people", teasing, bragging, complaining, a one-word jab
- jokes, sass, rhetorical questions, strong opinions, personal asides
- casual emoji, hype and announcements in social posts and group chats. Emoji or a hype opener are NOT chatbot signs on their own. Count chatbot signs only when you also see step lists, levels, bold or asterisk markup, or a closing offer.
- specific names, places, prices, numbers or private details that matter to the writer
- uneven rhythm that is random, not patterned

Signs of AI in prose (one stock phrase alone is a weak sign; several together are a strong one):
- stock phrases: "a wave of", "the weight of", "a mix of X and Y", "a sense of", "for a moment", "a beat", "something like", "the kind of X that Y", "the air smelled of", "heart pounded", "a breath she didn't know she was holding", "eyes sparkled"
- stock vocabulary: tapestry, testament, delve, realm, intricate, bustling, vibrant, palpable, ethereal, "symphony of", "dance of", "plays a crucial role", "it's important to note"
- connective filler: however, moreover, furthermore, ultimately, indeed, in the end
- compressed, overly clever similes; "said it like X"; "as if he was trying to"; "the way X did"
- negation patterns: "wasn't X, it was Y"; "not just X, but Y"; repeated "didn't X. Didn't Y."; "Nobody X. Nobody Y."; "Nothing X. Nothing Y."
- lists or sequences of three; tidy mirrored pairs
- the same sentence skeleton or the same opening word repeated several times in a row (for example "[Name] + verb + what they own" over and over)
- uniform sentence length or paragraph length
- a narrator explaining a character's feelings or the meaning of an action instead of showing it (count this only when the line is also polished or literary; plain telling in a raw draft is normal)
- a neat closing line that wraps up a paragraph or scene with a reflection or lesson
- a scene-ending line that hints trouble is coming ("Whatever came next, she was not ready for it")
- an object, feeling or silence given plans or a will of its own ("the quiet had no intention of leaving")
- a character trait summed up in one neat sentence ("He read people fast and trusted none of them")
- comparisons to the recent past ("quieter than it had been in weeks")
- "the one that", "the kind that" or "the one underneath" tacked onto a noun for a literary effect
- characters explaining things to each other that both already know
- dialogue too polished, balanced or complete for anyone to say out loud
- vague big words where a specific detail should be
- em dashes or semicolons used for dramatic effect

Leftovers from "humanizing" (these still count as AI):
- short fragments dropped in on a schedule ("Silence. Then footsteps. Then nothing.")
- every paragraph a one-liner, or every paragraph the same short length
- the same small mannerism over and over ("just", "quietly", "somehow", "a beat")
- fake mess that is spread out evenly instead of random

Signs of an AI chatbot reply:
- numbered or bulleted step lists, tiers or levels ("Level 1, Level 2"), bold or asterisk markup, headings
- a friendly hype opener or praise for the idea, but only together with the list structure above
- reassuring absolutes such as "100% safe"
- every item given the same format and weight, like a price list
- a closing line that offers a next step or asks which option the reader wants
- a hook opener, then several bold-labelled or numbered points of roughly equal size, then a punchy closer. Dialect, slang and bad spelling are never evidence of a human writer. Bold or numbered formatting alone is NOT evidence of AI, since many people format WhatsApp posts that way.

Calibration examples (follow these scores closely):
AI-written:
- "Level 1: Start with one small stall. Na the safest way and e dey cheap. Tell me which level you wan try, I go send the full plan for you now now." → 0.95 (chatbot structure, reassuring absolute, closing offer, even in Pidgin)
- "how e dey work: *1. The Share na the weapon* Dem no get money for advert, so dem use YOU. *2.* Dem go carry you go one website full of ads. *3.* Sometimes e worse pass ads. Na exponential growth. Na mathematics." → 0.85 (hook, equal-weight labelled points, punchy closer, even in Pidgin)
- "Harlow ran the docks. Pryce owned the mines. Dunmore bought whatever the others sold. Wick kept the books for all three." → 0.80 for each (same skeleton four times, too neat)
- "A wave of sadness washed over her as the weight of the moment settled in." → 0.90 (stock phrases, narrator explains the feeling)
- "Nobody spoke. Nobody moved. Nobody dared to breathe." → 0.90 (repeated negation, sequence of three)
- "I will not apologize for protecting this family, and I will not pretend your choices have not hurt us all." → 0.90 (too balanced and complete for speech)
- "Little did she know, the real trouble had only just begun." → 0.85 (stock teaser line)
Human-written:
- "He locked the shop late and forgot his umbrella. It rained the whole way home." → 0.15 (plain, concrete, slightly uneven)
- "Not tonight," Tola said. "My feet are killing me." → 0.15 (plain, natural dialogue)
- "📢 Small small update: free slots open Friday. First come first served o. And before anybody asks, no, I will not answer 'is it still available' ten times." → 0.10 (casual social post: emoji, banter, direct address)
- "Tola dropped the bag by the door and sat on the stairs, she was too tired to go up. Her mother was shouting in the kitchen again about the light bill" → 0.15 (raw run-on, plain, specific details)
- "She felt sad when he left. She cried all night and did not eat." → 0.35 (plain direct telling is normal for a new writer; a weak sign at most)

Scoring rules:
- Score each sentence on its own signs. A sentence that shows no clear sign of AI scores 0.3 or lower, even if it is plain, clean or unpunctuated. A sentence that shows only human voice scores 0.15 or lower.
- One weak sign (a single stock phrase or word) scores 0.4 to 0.6. A clear structural sign, or two or more signs together, scores 0.7 to 0.95.
- Plain telling or a single odd phrase in a rough draft scores at most 0.5 unless the sentence also has a stock phrase, stock vocabulary or chatbot structure.
- If three or more sentences in a row share the same skeleton, opener or negation pattern, score every sentence in that run at least 0.7, even in a rough draft.
- Set "overall" from how much of the piece shows signs, not from how many kinds of signs you found. A chat-style reply (a step list or levels, bold markup, a closing offer) must have "overall" at least 0.85.
- Use the full range from 0 to 1. Do not bunch scores around the middle.

Respond with ONLY valid JSON in this exact shape, no other text:
{"overall": 0.0, "sentences": [{"i": 1, "score": 0.0}, {"i": 2, "score": 0.0}]}

"overall" is your 0-1 estimate for the whole passage. Each "score" is 0-1 for that one sentence. 0 means clearly human-written, 1 means clearly AI-written. Include every sentence number exactly once, in order.`;

async function callDetector(sentences) {
  const numbered = sentences.map((s, i) => `${i + 1}: ${s}`).join('\n');

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          temperature: 0,
          reasoning_effort: 'low',
          response_format: { type: 'json_object' },
          max_completion_tokens: 12000,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: numbered },
          ],
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        const message = data && data.error ? data.error.message || data.error : `HTTP ${response.status}`;
        throw new Error(message);
      }

      const raw = data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : null;

      if (!raw) throw new Error('Empty response from model.');

      return JSON.parse(raw);
    } catch (e) {
      lastError = e;
      const retryable = /validate JSON|failed_generation|not valid JSON|Unexpected token|Empty response/i.test(e.message || '');
      if (!retryable) break;
    }
  }
  throw lastError;
}
}

const MIN_WORDS = 40;

const STOCK_PHRASES = [
  'a wave of', 'the weight of', 'a sense of', 'a mix of', 'for a moment',
  'a beat', 'tapestry', 'testament', 'delve', 'palpable', 'ethereal',
  'symphony of', 'in the end', "it's important to note", 'little did',
  'heart pounded', 'moreover', 'furthermore', 'ultimately', 'vibrant',
  'bustling', 'intricate',
];

function countWords(t) {
  return (t.match(/\S+/g) || []).length;
}

function looksLikeGibberish(text) {
  const tokens = text.toLowerCase().match(/[a-z]{5,}/g) || [];
  if (tokens.length < 3) return false;
  const bad = tokens.filter((t) => /[^aeiouy]{5,}/.test(t)).length;
  return bad / tokens.length > 0.3;
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));

function styleSignals(sentences, fullText) {
  const lens = sentences.map(countWords);
  const mean = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / (lens.length || 1);
  const cv = mean ? Math.sqrt(variance) / mean : 0;
  const uniform = clamp01((0.55 - cv) / 0.3);

  const openers = sentences.map((s) => (s.toLowerCase().match(/[a-z']+/) || [''])[0]);
  let repeats = 0;
  for (let i = 1; i < openers.length; i++) {
    if (openers[i] && openers[i] === openers[i - 1]) repeats++;
  }
  const repeat = clamp01(repeats / Math.max(1, openers.length - 1) / 0.4);

  const lower = fullText.toLowerCase();
  const hits = STOCK_PHRASES.filter((p) => lower.includes(p)).length;
  const per100 = hits / Math.max(1, countWords(fullText) / 100);
  const stock = clamp01(per100 / 2);

  const score = 0.35 * uniform + 0.35 * repeat + 0.3 * stock;
  return { score: clamp01(score), uniform, repeat, stock };
}

function bandFor(score) {
  if (score < 0.35) return 'human';
  if (score <= 0.65) return 'inconclusive';
  return 'ai';
}

app.post('/api/detect', async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(500).json({
        error: 'Server is missing GROQ_API_KEY. Add it to your .env file and restart.',
      });
    }

    const text = (req.body && req.body.text ? String(req.body.text) : '').trim();
    if (!text) {
      return res.status(400).json({ error: 'Paste some text first.' });
    }

    if (countWords(text) < MIN_WORDS) {
      return res.status(400).json({
        error: `Too short to judge. Paste at least ${MIN_WORDS} words; short text can't be scored reliably.`,
      });
    }
    if (looksLikeGibberish(text)) {
      return res.status(400).json({
        error: "This looks like random characters, so it can't be assessed.",
      });
    }

    const sentences = splitIntoSentences(text);
    if (sentences.length === 0) {
      return res.status(400).json({ error: "Couldn't find any sentences in that." });
    }

    const result = await callDetector(sentences);

    const scoreByIndex = new Map(
      (result.sentences || []).map((s) => [s.i, s.score])
    );

    const perSentence = sentences.map((sentence, idx) => {
      const score = scoreByIndex.has(idx + 1) ? scoreByIndex.get(idx + 1) : 0.5;
      const clamped = Math.max(0, Math.min(1, Number(score) || 0));
      return { text: sentence, label: clamped >= 0.5 ? 'ai' : 'human', aiScore: clamped };
    });

    const llmOverall =
      typeof result.overall === 'number'
        ? clamp01(result.overall)
        : perSentence.reduce((sum, s) => sum + s.aiScore, 0) / perSentence.length;

    const signals = styleSignals(sentences, text);
    const w = sentences.length >= 8 ? 0.25 : 0.1;
    const overall = clamp01((1 - w) * llmOverall + w * signals.score);

    res.json({
      overallAiScore: overall,
      band: bandFor(overall),
      llmScore: llmOverall,
      styleScore: signals.score,
      sentences: perSentence,
    });
  } catch (err) {
    console.error(err);
    const isRateLimit = err.message && /rate.?limit/i.test(err.message);
    res.status(502).json({
      error: isRateLimit
        ? 'Hit Groq\u2019s free-tier rate limit \u2014 wait a minute and try again.'
        : `Detector request failed: ${err.message}`,
    });
  }
});

app.post('/api/humanize', async (req, res) => {
  try {
    const ownerKey = req.body && req.body.ownerKey ? String(req.body.ownerKey) : '';
    const isOwner = Boolean(OWNER_KEY) && ownerKey === OWNER_KEY;

    if (!isOwner) {
      return res.status(402).json({
        error: 'This is a premium feature. Payment isn\u2019t set up yet.',
        paymentRequired: true,
      });
    }

    if (!GROQ_API_KEY) {
      return res.status(500).json({
        error: 'Server is missing GROQ_API_KEY. Add it to your .env file and restart.',
      });
    }

    const text = (req.body && req.body.text ? String(req.body.text) : '').trim();
    if (!text) {
      return res.status(400).json({ error: 'Paste some text first.' });
    }

    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 1.0,
        max_completion_tokens: 10000,
        messages: [
          { role: 'system', content: HUMANIZE_SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const message = data && data.error ? data.error.message || data.error : `HTTP ${response.status}`;
      throw new Error(message);
    }

    const rewritten = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
    if (!rewritten) throw new Error('Empty response from model.');

    res.json({ rewritten: rewritten.trim() });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: `Humanize request failed: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`Is This Yours? running at http://localhost:${PORT}`);
});
