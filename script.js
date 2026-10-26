// ---- Tab switching ----
const tabText = document.getElementById('tabText');
const tabImage = document.getElementById('tabImage');
const textPanel = document.getElementById('textPanel');
const imagePanel = document.getElementById('imagePanel');
const subText = document.getElementById('subText');

const TEXT_SUB = "Paste a chapter below. We'll tell you which lines read like they weren't typed by a person — so you can fix them before an editor does.";
const IMAGE_SUB = "Upload an image below. We'll tell you whether it looks AI-generated, and why.";

const tabHumanize = document.getElementById('tabHumanize');
const humanizePanel = document.getElementById('humanizePanel');
const HUMANIZE_SUB = 'Paste text below and get it rewritten to read less like AI. Premium feature \u2014 owner access only for now.';

function setTabFull(which) {
  const panels = { text: textPanel, image: imagePanel, humanize: humanizePanel };
  const tabs = { text: tabText, image: tabImage, humanize: tabHumanize };
  Object.keys(panels).forEach((key) => {
    const isActive = key === which;
    panels[key].hidden = !isActive;
    tabs[key].classList.toggle('active', isActive);
    tabs[key].setAttribute('aria-selected', String(isActive));
  });
  subText.textContent = which === 'text' ? TEXT_SUB : which === 'image' ? IMAGE_SUB : HUMANIZE_SUB;
}

tabText.addEventListener('click', () => setTabFull('text'));
tabImage.addEventListener('click', () => setTabFull('image'));
tabHumanize.addEventListener('click', () => setTabFull('humanize'));

// ---- Humanize (owner-gated) ----
const humanizeForm = document.getElementById('humanizeForm');
const humanizeInput = document.getElementById('humanizeInput');
const ownerKeyInput = document.getElementById('ownerKeyInput');
const humanizeBtn = document.getElementById('humanizeBtn');
const humanizeErrorEl = document.getElementById('humanizeErrorMsg');
const humanizeResults = document.getElementById('humanizeResults');
const humanizeOutputEl = document.getElementById('humanizeOutput');
const copyBtn = document.getElementById('copyBtn');

// Remember the access code in this browser only, so the owner doesn't
// have to retype it every visit. Never sent anywhere except our own
// /api/humanize call.
const savedKey = localStorage.getItem('ownerKey');
if (savedKey) ownerKeyInput.value = savedKey;

function setHumanizeLoading(isLoading) {
  humanizeBtn.disabled = isLoading;
  humanizeBtn.textContent = isLoading ? 'Rewriting…' : 'Rewrite it';
}

humanizeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  humanizeErrorEl.hidden = true;
  humanizeResults.hidden = true;

  const text = humanizeInput.value.trim();
  if (!text) return;

  const ownerKey = ownerKeyInput.value.trim();
  localStorage.setItem('ownerKey', ownerKey);

  setHumanizeLoading(true);
  try {
    const response = await fetch('/api/humanize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ownerKey }),
    });

    const data = await response.json();

    if (!response.ok) {
      humanizeErrorEl.textContent = data.error || 'Something went wrong. Try again.';
      humanizeErrorEl.hidden = false;
      return;
    }

    humanizeOutputEl.textContent = data.rewritten;
    humanizeResults.hidden = false;
    humanizeResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    humanizeErrorEl.textContent = 'Could not reach the server. Is it running?';
    humanizeErrorEl.hidden = false;
  } finally {
    setHumanizeLoading(false);
  }
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(humanizeOutputEl.textContent);
    const original = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = original; }, 1500);
  } catch (err) {
    // Clipboard API can fail without permissions; fail silently, the
    // text is still selectable/visible either way.
  }
});

// ---- Image checking ----
const imageForm = document.getElementById('imageForm');
const imageInput = document.getElementById('imageInput');
const dropZoneText = document.getElementById('dropZoneText');
const imagePreview = document.getElementById('imagePreview');
const imageFileName = document.getElementById('imageFileName');
const checkImageBtn = document.getElementById('checkImageBtn');
const imageErrorEl = document.getElementById('imageErrorMsg');
const imageResults = document.getElementById('imageResults');
const imageStampEl = document.getElementById('imageStamp');
const imageScoreValueEl = document.getElementById('imageScoreValue');
const imageVerdictTextEl = document.getElementById('imageVerdictText');
const imageReasoningEl = document.getElementById('imageReasoning');

let selectedImageDataUrl = null;

// Resize client-side before upload — phone camera photos can be 4000px+
// and several MB; shrinking to a max dimension keeps requests fast and
// comfortably under the server's body-size limit.
function resizeImage(file, maxDimension) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          const scale = maxDimension / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

imageInput.addEventListener('change', async () => {
  const file = imageInput.files && imageInput.files[0];
  if (!file) return;

  imageErrorEl.hidden = true;
  imageResults.hidden = true;
  imageFileName.textContent = file.name;

  try {
    selectedImageDataUrl = await resizeImage(file, 1024);
    imagePreview.src = selectedImageDataUrl;
    imagePreview.hidden = false;
    dropZoneText.hidden = true;
  } catch (err) {
    selectedImageDataUrl = null;
    imageErrorEl.textContent = err.message;
    imageErrorEl.hidden = false;
  }
});

function setImageLoading(isLoading) {
  checkImageBtn.disabled = isLoading;
  checkImageBtn.textContent = isLoading ? 'Checking…' : 'Check the image';
}

imageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  imageErrorEl.hidden = true;
  imageResults.hidden = true;

  if (!selectedImageDataUrl) {
    imageErrorEl.textContent = 'Choose an image first.';
    imageErrorEl.hidden = false;
    return;
  }

  setImageLoading(true);
  try {
    const response = await fetch('/api/detect-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: selectedImageDataUrl }),
    });

    const data = await response.json();

    if (!response.ok) {
      imageErrorEl.textContent = data.error || 'Something went wrong. Try again.';
      imageErrorEl.hidden = false;
      return;
    }

    const pct = Math.round(data.aiScore * 100);
    imageStampEl.className =
      'stamp ' + (data.aiScore >= 0.65 ? 'ai' : data.aiScore >= 0.35 ? 'mixed' : 'human');
    imageStampEl.textContent =
      data.aiScore >= 0.65 ? 'likely AI' : data.aiScore >= 0.35 ? 'mixed signals' : 'likely real';
    imageScoreValueEl.textContent = `${pct}%`;
    imageVerdictTextEl.textContent = data.verdict || '';
    imageReasoningEl.textContent = data.reasoning || '';

    imageResults.hidden = false;
    imageResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    imageErrorEl.textContent = 'Could not reach the server. Is it running?';
    imageErrorEl.hidden = false;
  } finally {
    setImageLoading(false);
  }
});

const form = document.getElementById('checkForm');
const textarea = document.getElementById('manuscript');
const wordCountEl = document.getElementById('wordCount');
const checkBtn = document.getElementById('checkBtn');
const errorEl = document.getElementById('errorMsg');
const results = document.getElementById('results');
const stampEl = document.getElementById('stamp');
const scoreValueEl = document.getElementById('scoreValue');
const annotatedEl = document.getElementById('annotated');

function countWords(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

textarea.addEventListener('input', () => {
  const n = countWords(textarea.value);
  wordCountEl.textContent = `${n.toLocaleString()} word${n === 1 ? '' : 's'}`;
});

function riskClass(aiScore) {
  if (aiScore >= 0.65) return 'risk-high';
  if (aiScore >= 0.35) return 'risk-mid';
  return 'risk-low';
}

function stampFor(overallAiScore) {
  if (overallAiScore >= 0.65) {
    return { className: 'ai', text: 'reads as AI' };
  }
  if (overallAiScore >= 0.35) {
    return { className: 'mixed', text: 'mixed signals' };
  }
  return { className: 'human', text: 'reads as human' };
}

function renderAnnotated(sentences) {
  annotatedEl.innerHTML = '';
  sentences.forEach((s) => {
    const span = document.createElement('span');
    span.className = `sentence ${riskClass(s.aiScore)}`;
    span.textContent = s.text + ' ';
    span.title = `${Math.round(s.aiScore * 100)}% AI-pattern score`;
    annotatedEl.appendChild(span);
  });
}

function setLoading(isLoading) {
  checkBtn.disabled = isLoading;
  checkBtn.textContent = isLoading ? 'Checking…' : 'Check the text';
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.hidden = true;
  results.hidden = true;

  const text = textarea.value.trim();
  if (!text) return;

  setLoading(true);
  try {
    const response = await fetch('/api/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    const data = await response.json();

    if (!response.ok) {
      showError(data.error || 'Something went wrong. Try again.');
      return;
    }

    const { className, text: stampText } = stampFor(data.overallAiScore);
    stampEl.className = `stamp ${className}`;
    stampEl.textContent = stampText;
    scoreValueEl.textContent = `${Math.round(data.overallAiScore * 100)}%`;

    renderAnnotated(data.sentences);
    results.hidden = false;
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showError('Could not reach the server. Is it running?');
  } finally {
    setLoading(false);
  }
});
