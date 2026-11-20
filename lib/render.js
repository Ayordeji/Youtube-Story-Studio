// Video compiler: one clip per scene (image or video + narration), cached,
// then joined into a scene, an act or the full film.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SIZES = { '720p': [1280, 720], '1080p': [1920, 1080] };
const FPS = 25;
const VERSION = 3;   // bump to invalidate cached scene clips

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || err.message).trim().split('\n').slice(-4).join(' | ');
        return reject(new Error(`${bin} failed: ${tail}`));
      }
      resolve(String(stdout));
    });
  });
}

async function hasFfmpeg() {
  try { await run('ffmpeg', ['-version']); return true; } catch { return false; }
}

async function probeDuration(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
  const d = parseFloat(out.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error('Could not read the length of ' + path.basename(file));
  return d;
}

function stamp(file) {
  try { const s = fs.statSync(file); return `${path.basename(file)}:${s.size}:${Math.round(s.mtimeMs)}`; } catch { return 'none'; }
}

function captionChunks(text, maxChars = 40) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = [];
  words.forEach(w => {
    if ([...cur, w].join(' ').length > maxChars && cur.length) { lines.push(cur.join(' ')); cur = [w]; }
    else cur.push(w);
  });
  if (cur.length) lines.push(cur.join(' '));
  const chunks = [];
  for (let i = 0; i < lines.length; i += 2) chunks.push(lines.slice(i, i + 2).join('\n'));
  return chunks;
}

function findFont(workDir) {
  const candidates = [
    '/System/Library/Fonts/Supplemental/Arial Black.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const dest = path.join(workDir, 'caption_font.ttf');
      try { if (!fs.existsSync(dest)) fs.copyFileSync(c, dest); return 'caption_font.ttf'; } catch { /* try next */ }
    }
  }
  return null;
}

// Renders one scene to renders/scenes/<id>.mp4 and returns its path.
// Reuses the existing clip when nothing that affects it has changed.
async function renderScene(projectDir, scene, index, opts) {
  const [W, H] = SIZES[opts.size] || SIZES['1080p'];
  const scenesDir = path.join(projectDir, 'renders', 'scenes');
  const workDir = path.join(projectDir, 'renders', 'work');
  fs.mkdirSync(scenesDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  const assetPath = scene.asset ? path.join(projectDir, 'assets', scene.asset.file) : null;
  const audioPath = scene.audio ? path.join(projectDir, 'audio', scene.audio.file) : null;
  const hasAsset = assetPath && fs.existsSync(assetPath);
  const hasAudio = audioPath && fs.existsSync(audioPath);
  if (!hasAsset && !opts.placeholders) throw new Error(`${scene.id} has no image or video yet.`);
  if (!hasAudio && !opts.placeholders) throw new Error(`${scene.id} has no narration yet.`);

  const outFile = path.join(scenesDir, `${scene.id}.mp4`);
  const keyFile = path.join(scenesDir, `${scene.id}.key`);
  const captionsOn = !!opts.captions;
  const key = crypto.createHash('sha1').update(JSON.stringify([
    VERSION, W, H, index % 2, captionsOn, captionsOn ? scene.narration : '',
    hasAsset ? stamp(assetPath) : 'placeholder', hasAudio ? stamp(audioPath) : 'silent:' + scene.words,
  ])).digest('hex');
  if (fs.existsSync(outFile) && fs.existsSync(keyFile) && fs.readFileSync(keyFile, 'utf8') === key) {
    return { file: outFile, cached: true };
  }

  const duration = hasAudio ? await probeDuration(audioPath) : Math.max(3, scene.words / 2.4);
  const frames = Math.ceil(duration * FPS);
  const isVideo = hasAsset && /\.(mp4|webm|mov|m4v)$/i.test(assetPath);

  const inputs = [];
  let base;
  if (!hasAsset) {
    inputs.push('-f', 'lavfi', '-i', `color=c=0x15171c:s=${W}x${H}:r=${FPS}`);
    base = `[0:v]format=yuv420p`;
  } else if (isVideo) {
    inputs.push('-stream_loop', '-1', '-i', assetPath);
    base = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setpts=PTS-STARTPTS,format=yuv420p`;
  } else {
    // Slow push-in on even scenes, pull-out on odd ones. Scaled up first so the move is smooth.
    const zoom = index % 2 === 0 ? `1.0+0.12*on/${frames}` : `1.12-0.12*on/${frames}`;
    inputs.push('-framerate', String(FPS), '-loop', '1', '-i', assetPath);
    base = `[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='${zoom}':x='trunc(iw/2-(iw/zoom)/2)':y='trunc(ih/2-(ih/zoom)/2)':d=1:s=${W}x${H}:fps=${FPS},format=yuv420p`;
  }
  if (hasAudio) inputs.push('-i', audioPath);
  else inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');

  const filters = [];
  const tempFiles = [];
  const font = findFont(workDir);
  const fontArg = font ? `:fontfile=${font}` : '';
  const fontSize = Math.round(H * 0.052);
  if (!hasAsset) {
    const label = path.join(workDir, `label_${scene.id}.txt`);
    fs.writeFileSync(label, `${scene.id}\nimage missing`);
    tempFiles.push(label);
    filters.push(`drawtext=textfile=${path.basename(label)}${fontArg}:fontcolor=0x8a8f98:fontsize=${fontSize}:x=(w-text_w)/2:y=(h-text_h)/2`);
  }
  if (captionsOn && scene.narration) {
    const chunks = captionChunks(scene.narration);
    const totalLen = chunks.reduce((a, c) => a + c.replace(/\n/g, ' ').length, 0) || 1;
    let t = 0;
    chunks.forEach((chunk, j) => {
      const file = path.join(workDir, `cap_${scene.id}_${j}.txt`);
      fs.writeFileSync(file, chunk.toUpperCase(), 'utf8');
      tempFiles.push(file);
      const len = (chunk.replace(/\n/g, ' ').length / totalLen) * duration;
      const start = t, end = j === chunks.length - 1 ? duration : t + len;
      t += len;
      filters.push(`drawtext=enable='between(t,${start.toFixed(3)},${end.toFixed(3)})':textfile=${path.basename(file)}${fontArg}:fontcolor=yellow:fontsize=${fontSize}:borderw=4:bordercolor=black:line_spacing=6:x=(w-text_w)/2:y=h-text_h-${Math.round(H * 0.1)}`);
    });
  }
  const fade = Math.min(0.4, duration / 4);
  filters.push(`fade=in:st=0:d=${fade.toFixed(3)}`, `fade=out:st=${(duration - fade).toFixed(3)}:d=${fade.toFixed(3)}`);
  const graph = `${base},${filters.join(',')}[v]`;

  const tmpOut = path.join(scenesDir, `${scene.id}.partial.mp4`);
  try {
    await run('ffmpeg', [
      '-y', ...inputs, '-filter_complex', graph, '-map', '[v]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-t', duration.toFixed(3), '-movflags', '+faststart', tmpOut,
    ], { cwd: workDir });
    fs.renameSync(tmpOut, outFile);
    fs.writeFileSync(keyFile, key);
  } finally {
    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch { /* ignore */ } });
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
  return { file: outFile, cached: false, duration };
}

// Joins finished scene clips into one file. Video is copied, audio re-encoded
// once so there are no gaps at the joins.
async function joinScenes(projectDir, clipFiles, outName, opts = {}) {
  const rendersDir = path.join(projectDir, 'renders');
  const workDir = path.join(rendersDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  const outFile = path.join(rendersDir, outName);
  if (clipFiles.length === 1 && !opts.overlay) {
    fs.copyFileSync(clipFiles[0], outFile);
    return outFile;
  }
  const list = path.join(workDir, `join_${Date.now()}.txt`);
  fs.writeFileSync(list, clipFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const joined = opts.overlay ? path.join(workDir, `joined_${Date.now()}.mp4`) : outFile;
  try {
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', joined]);
    if (opts.overlay) {
      // Corner badge (for example a subscribe button on a black background).
      await run('ffmpeg', [
        '-y', '-i', joined, '-loop', '1', '-i', opts.overlay,
        '-filter_complex', '[1:v]colorkey=0x000000:0.05:0.05,scale=220:-1,fade=in:st=2:d=1:alpha=1[sub];[0:v][sub]overlay=W-w-10:10:shortest=1',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', outFile,
      ]);
    }
  } finally {
    try { fs.unlinkSync(list); } catch { /* ignore */ }
    if (opts.overlay) { try { fs.unlinkSync(joined); } catch { /* ignore */ } }
  }
  return outFile;
}

// Joins several narration pieces into one .wav file.
async function joinAudio(files, outFile) {
  if (files.length === 1) { fs.renameSync(files[0], outFile); return outFile; }
  const args = ['-y'];
  files.forEach(f => args.push('-i', f));
  args.push('-filter_complex', `${files.map((_, i) => `[${i}:a]`).join('')}concat=n=${files.length}:v=0:a=1[a]`, '-map', '[a]', outFile);
  await run('ffmpeg', args);
  files.forEach(f => { try { fs.unlinkSync(f); } catch { /* ignore */ } });
  return outFile;
}

module.exports = { SIZES, run, hasFfmpeg, probeDuration, renderScene, joinScenes, joinAudio };
