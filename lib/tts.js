// Narrator voices. Carried over from the previous system: the local Kokoro
// voice model and the built-in macOS voices. Both run on this computer.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

let AUDIO_DIR = require('os').tmpdir();   // temp space for the macOS voice

const MAC_VOICES = [
  { name: 'mac_Samantha', displayName: 'Samantha (US Female - Studio Expressive)', systemVoice: 'Samantha', tier: 'mac', lang: 'en-US' },
  { name: 'mac_Daniel', displayName: 'Daniel (UK Male - Classic Narrator)', systemVoice: 'Daniel', tier: 'mac', lang: 'en-GB' },
  { name: 'mac_Flo', displayName: 'Flo (UK Female - Calm Storyteller)', systemVoice: 'Flo (English (UK))', tier: 'mac', lang: 'en-GB' },
  { name: 'mac_Karen', displayName: 'Karen (Australian Female - Expressive)', systemVoice: 'Karen', tier: 'mac', lang: 'en-AU' },
  { name: 'mac_Eddy', displayName: 'Eddy (US Male - Confident Drama)', systemVoice: 'Eddy (English (US))', tier: 'mac', lang: 'en-US' },
  { name: 'mac_Moira', displayName: 'Moira (Irish Female - Warm)', systemVoice: 'Moira', tier: 'mac', lang: 'en-IE' },
  { name: 'mac_Tessa', displayName: 'Tessa (South African Female)', systemVoice: 'Tessa', tier: 'mac', lang: 'en-ZA' },
  { name: 'mac_Rishi', displayName: 'Rishi (Indian Male)', systemVoice: 'Rishi', tier: 'mac', lang: 'en-IN' }
];

function synthesizeTextMac(text, voiceId, outputFile) {
  return new Promise((resolve, reject) => {
    const voiceObj = MAC_VOICES.find(v => v.name === voiceId) || MAC_VOICES[0];
    const systemVoice = voiceObj.systemVoice;
    const tempAiff = path.join(AUDIO_DIR, `temp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.aiff`);
    
    execFile('say', ['-v', systemVoice, '-o', tempAiff, text], (err) => {
      if (err) return reject(new Error(`Mac TTS failed: ${err.message}`));
      
      execFile('afconvert', ['-f', 'WAVE', '-d', 'LEI16', tempAiff, outputFile], (convErr) => {
        try { if (fs.existsSync(tempAiff)) fs.unlinkSync(tempAiff); } catch (e) {}
        if (convErr) return reject(new Error(`Audio conversion failed: ${convErr.message}`));
        resolve(outputFile);
      });
    });
  });
}

// ─── LOCAL TEXT-TO-SPEECH (Kokoro TTS - Quantized & Multi-Threaded) ───────────

const os = require('os');
let kokoroTTSInstance = null;
async function getKokoroInstance() {
  if (!kokoroTTSInstance) {
    console.log('[TTS] Initializing Kokoro TTS (q4 optimized)...');
    try {
      const { env } = await import('@huggingface/transformers');
      if (env && env.backends && env.backends.onnx) {
        env.backends.onnx.wasm.numThreads = Math.min(8, os.cpus().length || 4);
      }
    } catch (e) {}

    const { KokoroTTS } = await import('kokoro-js');
    const model_id = "onnx-community/Kokoro-82M-v1.0-ONNX";
    kokoroTTSInstance = await KokoroTTS.from_pretrained(model_id, { 
        dtype: "q8", 
        device: "cpu" 
    });
    console.log('[TTS] Kokoro TTS successfully initialized with fast q4 quantization.');
  }
  return kokoroTTSInstance;
}

const KOKORO_VOICES = [
  { name: 'af_bella', displayName: 'Bella (US Female - Expressive & Rich)', tier: 'kokoro', lang: 'en-US (Female)' },
  { name: 'af_heart', displayName: 'Heart (US Female - Warm & Cinematic)', tier: 'kokoro', lang: 'en-US (Female)' },
  { name: 'af_nicole', displayName: 'Nicole (US Female - Soft & Quiet)', tier: 'kokoro', lang: 'en-US (Female)' },
  { name: 'af_sky', displayName: 'Sky (US Female - Natural)', tier: 'kokoro', lang: 'en-US (Female)' },
  { name: 'am_adam', displayName: 'Adam (US Male - Deep & Measured)', tier: 'kokoro', lang: 'en-US (Male)' },
  { name: 'am_echo', displayName: 'Echo (US Male - Crisp & Clear)', tier: 'kokoro', lang: 'en-US (Male)' },
  { name: 'am_eric', displayName: 'Eric (US Male - Narrative Flow)', tier: 'kokoro', lang: 'en-US (Male)' },
  { name: 'am_liam', displayName: 'Liam (US Male - Modern & Youthful)', tier: 'kokoro', lang: 'en-US (Male)' },
  { name: 'am_michael', displayName: 'Michael (US Male - Serious & Authoritative)', tier: 'kokoro', lang: 'en-US (Male)' }
];

const VOICES = [...KOKORO_VOICES, ...MAC_VOICES];
const DEFAULT_VOICE = 'af_bella';

// Writes narration for `text` to a .wav file at `outputFile`.
async function synthesize(text, voice, speed, outputFile) {
  const selected = voice || DEFAULT_VOICE;
  AUDIO_DIR = path.dirname(outputFile);
  if (selected.startsWith('mac_')) {
    await synthesizeTextMac(text, selected, outputFile);
    return outputFile;
  }
  const fallback = selected.startsWith('am_') ? 0.85 : 0.95;
  const rate = Number.isFinite(parseFloat(speed)) ? parseFloat(speed) : fallback;
  const tts = await getKokoroInstance();
  const audio = await tts.generate(text, { voice: selected, speed: rate });
  await audio.save(outputFile);
  return outputFile;
}

module.exports = { VOICES, KOKORO_VOICES, MAC_VOICES, DEFAULT_VOICE, synthesize };
