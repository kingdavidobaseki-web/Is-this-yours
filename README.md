# Is This Yours?

A small web app that checks pasted text against an open AI-text-detection
model and highlights the sentences most likely to read as AI-written —
built so you can self-check a chapter before Nettalez's (or any) editor does.

## How it works

- You paste text into the browser.
- The Node server splits it into sentences and sends it to a free,
  open-source detector model (`Hello-SimpleAI/chatgpt-detector-roberta`)
  hosted on Hugging Face's Inference API.
- You get back an overall score plus a highlighted, sentence-by-sentence
  breakdown — shaded gold for medium risk, red for high risk.

This is a **second opinion**, not a verdict. Like ZeroGPT and GPTZero, it
will sometimes flag clean human writing and miss AI writing. Use it to
spot likely trouble lines, not as proof of anything.

## Setup

1. **Install Node.js 18 or newer** if you don't have it:
   https://nodejs.org (LTS version is fine).

2. **Get a free Hugging Face token:**
   - Create a free account at https://huggingface.co/join
   - Go to https://huggingface.co/settings/tokens
   - Click "New token", give it any name, choose the **Read** role
   - Copy the token (starts with `hf_...`)

3. **Install dependencies.** In this folder, run:
   ```
   npm install
   ```

4. **Add your token.** Copy `.env.example` to a new file named `.env`,
   and paste your token in:
   ```
   HF_TOKEN=hf_your_actual_token_here
   ```

5. **Run it:**
   ```
   npm start
   ```

6. Open **http://localhost:3000** in your browser, paste a chapter, and
   click "Check the text".

## Notes on the free tier

- The **first** request after a while can take 10–20 seconds — Hugging
  Face "wakes up" the model on demand. The server already tells it to
  wait rather than fail; just give it a moment.
- The free tier allows a few hundred requests per hour. Each click of
  "Check the text" uses 2 requests (one for the whole text, one batched
  call for every sentence), so you have plenty of room for normal use.
- Long chapters are capped at the first 120 sentences for the per-line
  breakdown, to keep each check fast and comfortably inside the free
  limits.

## Where to take this next

- **Swap the model**: any other text-classification detector model on
  Hugging Face works by changing `MODEL_ID` in `server.js`.
- **Deploy it** so you can use it from your phone without your laptop
  running: Render, Railway, and Fly.io all have free tiers that work
  for a small Node app like this. Just set `HF_TOKEN` as an environment
  variable there instead of a local `.env` file.
- **Turn it into a product**: add accounts and a usage limit per user,
  and you've got the bones of a paid tool for other writers — same
  business model as ZeroGPT itself.
