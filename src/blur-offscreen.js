// Offscreen inference window — uses nsfwjs for NSFW/explicit content detection
// Communicates with main process via ipcRenderer

const { ipcRenderer } = require('electron');

let nsfwModel = null;
let modelState = 'idle'; // idle | loading | ready | error

// ── Load nsfwjs model ─────────────────────────────────────────────────────────
async function loadModel() {
  if (nsfwModel) return nsfwModel;
  if (modelState === 'loading') {
    while (modelState === 'loading') await sleep(200);
    return nsfwModel;
  }
  modelState = 'loading';
  ipcRenderer.send('blur-model-status', { ready: false, loading: true });

  try {
    // Set CPU backend before loading nsfwjs (offscreen window has no GPU context)
    const tf = require('@tensorflow/tfjs');
    await tf.setBackend('cpu');
    await tf.ready();
    console.log('[BlurOffscreen] TF.js backend:', tf.getBackend());

    const nsfwjs = require('nsfwjs');
    // Load MobileNetV2 (fastest, 224x224, weights bundled in JS)
    nsfwModel = await nsfwjs.load();
    modelState = 'ready';
    console.log('[BlurOffscreen] nsfwjs model loaded');
    ipcRenderer.send('blur-model-status', { ready: true });
    return nsfwModel;
  } catch (e) {
    console.error('[BlurOffscreen] Model load failed:', e.message);
    modelState = 'error';
    ipcRenderer.send('blur-model-status', { ready: false, error: e.message });
    return null;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Run inference on an image data URL ───────────────────────────────────────
async function runDetection(imageDataUrl, settings) {
  const model = await loadModel();
  if (!model) return { detections: [], error: 'Model not available' };

  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Image decode failed'));
      img.src = imageDataUrl;
    });

    // nsfwjs.classify() returns array of { className, probability }
    // Classes: Drawing, Hentai, Neutral, Porn, Sexy
    const predictions = await model.classify(img);

    const threshold = (settings.threshold || 40) / 100;
    const target = settings.target || 'explicit'; // 'explicit' | 'suggestive' | 'all'

    // Determine which classes to flag based on target setting
    const flaggedClasses = getFlaggedClasses(target);

    const detections = predictions
      .filter(p => flaggedClasses.includes(p.className) && p.probability >= threshold)
      .map(p => ({ className: p.className, score: p.probability }));

    return { detections };
  } catch (e) {
    console.error('[BlurOffscreen] Inference error:', e.message);
    return { detections: [], error: e.message };
  }
}

function getFlaggedClasses(target) {
  switch (target) {
    case 'explicit':   return ['Porn', 'Hentai'];
    case 'suggestive': return ['Sexy'];
    case 'all':        return ['Porn', 'Hentai', 'Sexy'];
    default:           return ['Porn', 'Hentai'];
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcRenderer.on('blur-detect', async (event, { requestId, imageDataUrl, settings }) => {
  console.log('[BlurOffscreen] got blur-detect, modelState=' + modelState + ', imgLen=' + (imageDataUrl ? imageDataUrl.length : 0));
  const result = await runDetection(imageDataUrl, settings);
  console.log('[BlurOffscreen] detection result: detections=' + result.detections.length + (result.error ? ' err=' + result.error : ''));
  ipcRenderer.send('blur-detect-result', { requestId, ...result });
});

ipcRenderer.on('blur-preload-model', () => {
  if (modelState === 'ready') {
    ipcRenderer.send('blur-model-status', { ready: true });
  } else if (modelState === 'error') {
    ipcRenderer.send('blur-model-status', { ready: false, error: 'Model load failed' });
  } else {
    ipcRenderer.send('blur-model-status', { ready: false, loading: true });
  }
});

// Preload model on startup
loadModel().then(m => {
  console.log('[BlurOffscreen] startup load result:', m ? 'OK' : 'FAILED');
});
