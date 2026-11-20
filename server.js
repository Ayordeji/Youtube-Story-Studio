// Story Studio: script in, consistent Flow prompts out, narrated video compiled locally.

const express = require('express');
const fs = require('fs');
const path = require('path');
const story = require('./lib/story');
const render = require('./lib/render');

// Use the bundled ffmpeg, ffprobe and node when they sit in ./bin (as in the previous system).
const binDir = path.join(__dirname, 'bin');
process.env.PATH = `${binDir}${path.delimiter}${path.join(binDir, 'bin')}${path.delimiter}${process.env.PATH}`;

const PORT = process.env.PORT || 3100;
const PROJECTS_DIR = path.join(__dirname, 'projects');
const OVERLAY_FILE = path.join(__dirname, 'subscribe_button.png');
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Project storage ─────────────────────────────────────────────────────────
const safeId = id => /^[a-z0-9-]+$/.test(String(id || ''));
const dirOf = id => path.join(PROJECTS_DIR, id);
const fileOf = id => path.join(dirOf(id), 'project.json');

function loadProject(id) {
  if (!safeId(id) || !fs.existsSync(fileOf(id))) {
    const err = new Error('Project not found.'); err.status = 404; throw err;
  }
  return JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
}

function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  const file = fileOf(project.id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(project, null, 2));
  fs.renameSync(tmp, file);
}

function allScenes(project) {
  const out = [];
  if (!project.plan) return out;
  project.plan.acts.forEach((act, ai) => act.scenes.forEach(sc => out.push({ scene: sc, actIndex: ai })));
  return out;
}

function findScene(project, sceneId) {
  const hit = allScenes(project).find(x => x.scene.id === sceneId);
  if (!hit) { const err = new Error(`Scene ${sceneId} not found.`); err.status = 404; throw err; }
  return hit.scene;
}

const wrap = fn => (req, res) => new Promise(resolve => resolve(fn(req, res))).catch(err => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message || String(err) });
});

function bad(message) { const e = new Error(message); e.status = 400; return e; }

function removeFile(file) { try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch { /* ignore */ } }

// ─── Background jobs (narration and compiling take a while) ─────────────────
const jobs = new Map();
let jobCounter = 0;
function startJob(type, projectId, total, worker) {
  const job = { id: `job${++jobCounter}_${Date.now()}`, type, projectId, status: 'running', done: 0, total, message: 'Starting', result: null, error: null };
  jobs.set(job.id, job);
  Promise.resolve().then(() => worker(job)).then(result => {
    job.status = 'finished'; job.result = result || null; job.message = 'Done';
  }).catch(err => {
    console.error(`[${type}]`, err.message);
    job.status = 'failed'; job.error = err.message;
  });
  return job;
}
const busy = (projectId, type) => [...jobs.values()].some(j => j.projectId === projectId && j.type === type && j.status === 'running');

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found. The app may have been restarted.' });
  res.json(job);
});

// ─── Health, voices ──────────────────────────────────────────────────────────
app.get('/api/health', wrap(async (req, res) => {
  let kokoro = true;
  try { require.resolve('kokoro-js'); } catch { kokoro = false; }
  res.json({ ok: true, ffmpeg: await render.hasFfmpeg(), kokoro, mac: process.platform === 'darwin', overlay: fs.existsSync(OVERLAY_FILE) });
}));

app.get('/api/voices', (req, res) => {
  const tts = require('./lib/tts');
  res.json({ voices: tts.VOICES, defaultVoice: tts.DEFAULT_VOICE });
});

// Short sample so a voice can be heard before it is chosen. Cached per voice, speed and text.
const PREVIEW_DIR = path.join(__dirname, 'projects', '.previews');
app.post('/api/voice-preview', wrap(async (req, res) => {
  const voice = String(req.body.voice || '');
  const speed = req.body.speed != null && req.body.speed !== '' ? req.body.speed : null;
  let text = String(req.body.text || '').trim();
  if (!text) text = 'The right story at the right moment can change a life.';
  text = text.split(/\s+/).slice(0, 45).join(' ');
  if (process.env.STUDIO_FAKE_TTS === undefined) {
    const tts = require('./lib/tts');
    if (!tts.VOICES.some(v => v.name === voice)) throw bad('Unknown voice.');
  }
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const key = require('crypto').createHash('md5').update([voice, speed, text].join('|')).digest('hex').slice(0, 16);
  const file = path.join(PREVIEW_DIR, key + '.wav');
  if (!fs.existsSync(file)) await narrate(text, voice, speed, file);
  res.sendFile(file);
}));

// ─── Projects ────────────────────────────────────────────────────────────────
app.get('/api/projects', wrap((req, res) => {
  const list = fs.readdirSync(PROJECTS_DIR).filter(id => safeId(id) && fs.existsSync(fileOf(id))).map(id => {
    const p = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
    return { id: p.id, title: p.title, updatedAt: p.updatedAt, scenes: allScenes(p).length, planned: !!p.plan };
  }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  res.json({ projects: list });
}));

app.post('/api/projects', wrap((req, res) => {
  const title = String(req.body.title || '').trim() || 'Untitled story';
  const script = String(req.body.script || '').trim();
  if (story.wordCount(script) < 30) throw bad('Paste the full script first. It needs at least a few sentences.');
  let base = story.slugify(title, 'story'), id = base, i = 2;
  while (fs.existsSync(dirOf(id))) id = `${base}-${i++}`;
  ['assets', 'refs', 'audio', 'renders'].forEach(d => fs.mkdirSync(path.join(dirOf(id), d), { recursive: true }));
  const project = {
    id, title, createdAt: new Date().toISOString(), script,
    sentences: story.splitSentences(script), plan: null,
    settings: { voice: null, speed: null, captions: true, size: '1080p', overlay: false },
  };
  saveProject(project);
  res.json({ project: story.hydrate(project) });
}));

app.get('/api/projects/:id', wrap((req, res) => {
  res.json({ project: story.hydrate(loadProject(req.params.id)) });
}));

// Replace the script of a project that has not been planned yet.
app.post('/api/projects/:id/script', wrap((req, res) => {
  const project = loadProject(req.params.id);
  const script = String(req.body.script || '').trim();
  if (story.wordCount(script) < 30) throw bad('Paste the full script first.');
  if (project.plan && !req.body.confirm) throw bad('This project already has a plan. Changing the script clears it.');
  project.script = script;
  project.sentences = story.splitSentences(script);
  project.plan = null;
  if (req.body.title) project.title = String(req.body.title).trim();
  saveProject(project);
  res.json({ project: story.hydrate(project) });
}));

app.get('/api/projects/:id/script', wrap((req, res) => {
  const project = loadProject(req.params.id);
  res.json({ title: project.title, script: project.script });
}));

app.get('/api/projects/:id/planner-prompt', wrap((req, res) => {
  const project = loadProject(req.params.id);
  const text = story.buildPlannerPrompt(project);
  if (req.query.download) {
    res.setHeader('Content-Disposition', `attachment; filename="${project.id}-planning-prompt.txt"`);
  }
  res.type('text/plain').send(text);
}));

app.post('/api/projects/:id/plan', wrap((req, res) => {
  const project = loadProject(req.params.id);
  let raw;
  try { raw = story.extractJson(req.body.text); } catch (e) { throw bad(e.message); }
  let result;
  try { result = story.normalizePlan(raw, project.sentences); } catch (e) { throw bad(e.message); }
  project.plan = result.plan;
  if (result.plan.title && /^untitled/i.test(project.title)) project.title = result.plan.title;
  saveProject(project);
  res.json({ project: story.hydrate(project), warnings: result.warnings });
}));

// ─── Edits (small, targeted, so background jobs are never overwritten) ──────
const pick = (src, keys) => { const o = {}; keys.forEach(k => { if (src[k] !== undefined) o[k] = src[k]; }); return o; };
const text = v => String(v == null ? '' : v).trim();

app.post('/api/projects/:id/edit', wrap((req, res) => {
  const project = loadProject(req.params.id);
  const { target, id, fields = {} } = req.body;
  const plan = project.plan;
  if (target === 'settings') {
    Object.assign(project.settings, pick(fields, ['voice', 'speed', 'captions', 'size', 'overlay']));
  } else if (target === 'title') {
    project.title = text(fields.title) || project.title;
  } else if (!plan) {
    throw bad('Import a plan first.');
  } else if (target === 'style') {
    plan.style = text(fields.style) || plan.style;
  } else if (target === 'character') {
    let ch = plan.characters.find(c => c.id === id);
    if (id === 'new') {
      let base = story.slugify(fields.name, 'character'), cid = base, i = 2;
      while (plan.characters.some(c => c.id === cid)) cid = `${base}-${i++}`;
      ch = { id: cid, name: text(fields.name) || 'New character', role: 'Supporting', anchor: '', wardrobe: [{ id: 'default', label: 'Default', description: '' }], refImage: null };
      plan.characters.push(ch);
    }
    if (!ch) throw bad('Character not found.');
    ['name', 'role', 'anchor'].forEach(k => { if (fields[k] !== undefined) ch[k] = text(fields[k]); });
    if (Array.isArray(fields.wardrobe) && fields.wardrobe.length) {
      const seen = new Set();
      ch.wardrobe = fields.wardrobe.map((w, i) => {
        let wid = story.slugify(w.id || w.label, `outfit-${i + 1}`);
        while (seen.has(wid)) wid += '-x';
        seen.add(wid);
        return { id: wid, label: text(w.label) || `Outfit ${i + 1}`, description: text(w.description) };
      });
    }
  } else if (target === 'location') {
    let loc = plan.locations.find(l => l.id === id);
    if (id === 'new') {
      let base = story.slugify(fields.name, 'location'), lid = base, i = 2;
      while (plan.locations.some(l => l.id === lid)) lid = `${base}-${i++}`;
      loc = { id: lid, name: text(fields.name) || 'New location', anchor: '', refImage: null };
      plan.locations.push(loc);
    }
    if (!loc) throw bad('Location not found.');
    ['name', 'anchor'].forEach(k => { if (fields[k] !== undefined) loc[k] = text(fields[k]); });
  } else if (target === 'act') {
    const act = plan.acts[parseInt(id, 10)];
    if (!act) throw bad('Act not found.');
    act.title = text(fields.title) || act.title;
  } else if (target === 'scene') {
    const sc = findScene(project, id);
    ['action', 'emotion', 'lighting', 'motion'].forEach(k => { if (fields[k] !== undefined) sc[k] = text(fields[k]); });
    if (fields.shot && story.SHOTS.includes(fields.shot)) sc.shot = fields.shot;
    if (fields.location && plan.locations.some(l => l.id === fields.location)) sc.location = fields.location;
    if (Array.isArray(fields.characters)) {
      sc.characters = fields.characters.map(e => {
        const ch = plan.characters.find(c => c.id === e.id);
        if (!ch) return null;
        const outfit = ch.wardrobe.find(w => w.id === e.wardrobe) || ch.wardrobe[0];
        return { id: ch.id, wardrobe: outfit.id };
      }).filter(Boolean);
    }
  } else {
    throw bad('Unknown edit.');
  }
  saveProject(project);
  res.json({ project: story.hydrate(project) });
}));

// ─── Uploads ─────────────────────────────────────────────────────────────────
const rawBody = express.raw({ type: '*/*', limit: '1gb' });
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.m4v'];
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg'];

function uploadExt(req, allowed) {
  let name = String(req.headers['x-filename'] || '');
  try { name = decodeURIComponent(name); } catch { /* keep as is */ }
  const ext = path.extname(name).toLowerCase();
  if (!allowed.includes(ext)) throw bad(`That file type (${ext || 'unknown'}) is not supported here. Use ${allowed.join(', ')}.`);
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('The upload was empty.');
  return ext;
}

app.post('/api/projects/:id/asset/:sceneId', rawBody, wrap((req, res) => {
  const ext = uploadExt(req, [...IMAGE_EXT, ...VIDEO_EXT]);
  const project = loadProject(req.params.id);
  const sc = findScene(project, req.params.sceneId);
  const file = `${sc.id}_${Date.now()}${ext}`;
  fs.writeFileSync(path.join(dirOf(project.id), 'assets', file), req.body);
  if (sc.asset) removeFile(path.join(dirOf(project.id), 'assets', sc.asset.file));
  sc.asset = { file, type: VIDEO_EXT.includes(ext) ? 'video' : 'image' };
  saveProject(project);
  res.json({ project: story.hydrate(project) });
}));

app.post('/api/projects/:id/ref/:kind/:refId', rawBody, wrap((req, res) => {
  const ext = uploadExt(req, IMAGE_EXT);
  const project = loadProject(req.params.id);
  if (!project.plan) throw bad('Import a plan first.');
  const listName = req.params.kind === 'location' ? 'locations' : 'characters';
  const item = project.plan[listName].find(x => x.id === req.params.refId);
  if (!item) throw bad('Reference target not found.');
  const file = `${listName}_${item.id}_${Date.now()}${ext}`;
  fs.writeFileSync(path.join(dirOf(project.id), 'refs', file), req.body);
  if (item.refImage) removeFile(path.join(dirOf(project.id), 'refs', item.refImage));
  item.refImage = file;
  saveProject(project);
  res.json({ project: story.hydrate(project) });
}));

app.post('/api/projects/:id/audio/:sceneId', rawBody, wrap(async (req, res) => {
  const ext = uploadExt(req, AUDIO_EXT);
  const project = loadProject(req.params.id);
  const sc = findScene(project, req.params.sceneId);
  const file = `${sc.id}_${Date.now()}${ext}`;
  const full = path.join(dirOf(project.id), 'audio', file);
  fs.writeFileSync(full, req.body);
  const duration = await render.probeDuration(full);
  const fresh = loadProject(project.id);
  const target = findScene(fresh, sc.id);
  if (target.audio) removeFile(path.join(dirOf(project.id), 'audio', target.audio.file));
  target.audio = { file, duration, voice: 'uploaded' };
  saveProject(fresh);
  res.json({ project: story.hydrate(fresh) });
}));

app.get('/media/:id/:folder/:file', wrap((req, res) => {
  const { id, folder, file } = req.params;
  if (!safeId(id) || !['assets', 'refs', 'audio', 'renders'].includes(folder) || file.includes('/') || file.includes('..')) throw bad('Bad path.');
  const full = path.join(dirOf(id), folder, file);
  if (!fs.existsSync(full)) return res.status(404).end();
  if (req.query.download) return res.download(full);
  res.sendFile(full);
}));

// ─── Narration ───────────────────────────────────────────────────────────────
async function narrate(textToSpeak, voice, speed, outFile) {
  if (process.env.STUDIO_FAKE_TTS) {   // test mode: a quiet tone of the right length
    const secs = Math.max(2, story.wordCount(textToSpeak) / 2.5).toFixed(2);
    await render.run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${secs}`, '-af', 'volume=0.05', outFile]);
    return;
  }
  const tts = require('./lib/tts');
  // Long passages are voiced in pieces of about 70 words, then joined.
  const pieces = [];
  let cur = [];
  story.splitSentences(textToSpeak).forEach(s => {
    if (cur.length && story.wordCount(cur.join(' ')) + s.words > 70) { pieces.push(cur.join(' ')); cur = []; }
    cur.push(s.text);
  });
  if (cur.length) pieces.push(cur.join(' '));
  const parts = [];
  for (let i = 0; i < pieces.length; i++) {
    const part = outFile.replace(/\.wav$/, `.part${i}.wav`);
    await tts.synthesize(pieces[i], voice, speed, part);
    parts.push(part);
  }
  await render.joinAudio(parts, outFile);
}

app.post('/api/projects/:id/narrate', wrap((req, res) => {
  const project = loadProject(req.params.id);
  if (!project.plan) throw bad('Import a plan first.');
  if (busy(project.id, 'narrate')) throw bad('Narration is already running for this project.');
  const hydrated = story.hydrate(project);
  const everything = allScenes(hydrated).map(x => x.scene);
  let pool = everything;
  if (req.body.actIndex != null && req.body.actIndex !== '') {
    const ai = parseInt(req.body.actIndex, 10);
    if (!hydrated.plan.acts[ai]) throw bad('That act does not exist.');
    pool = hydrated.plan.acts[ai].scenes;
  }
  let targets = pool;
  if (Array.isArray(req.body.sceneIds)) targets = everything.filter(s => req.body.sceneIds.includes(s.id));
  else if (req.body.onlyMissing) targets = pool.filter(s => !s.audio);
  if (!targets.length) throw bad('Every scene already has narration.');
  const voice = req.body.voice || project.settings.voice;
  const speed = req.body.speed != null && req.body.speed !== '' ? req.body.speed : project.settings.speed;

  const job = startJob('narrate', project.id, targets.length, async job => {
    for (const sc of targets) {
      job.message = `Voicing ${sc.id}`;
      const file = `${sc.id}_${Date.now()}.wav`;
      const full = path.join(dirOf(project.id), 'audio', file);
      await narrate(sc.narration, voice, speed, full);
      const duration = await render.probeDuration(full);
      const fresh = loadProject(project.id);          // re-read so edits made meanwhile are kept
      const target = findScene(fresh, sc.id);
      if (target.audio) removeFile(path.join(dirOf(project.id), 'audio', target.audio.file));
      target.audio = { file, duration, voice: voice || 'default' };
      saveProject(fresh);
      job.done++;
    }
    return { narrated: targets.length };
  });
  res.json({ job });
}));

// ─── Compile ─────────────────────────────────────────────────────────────────
app.post('/api/projects/:id/compile', wrap((req, res) => {
  const project = loadProject(req.params.id);
  if (!project.plan) throw bad('Import a plan first.');
  if (busy(project.id, 'compile')) throw bad('A compile is already running for this project.');
  const hydrated = story.hydrate(project);
  const everything = allScenes(hydrated);
  const { scope, sceneId, actIndex } = req.body;
  let chosen, outName;
  if (scope === 'scene') {
    chosen = everything.filter(x => x.scene.id === sceneId);
    outName = `${project.id}_${sceneId}.mp4`;
  } else if (scope === 'act') {
    chosen = everything.filter(x => x.actIndex === parseInt(actIndex, 10));
    outName = `${project.id}_act-${parseInt(actIndex, 10) + 1}.mp4`;
  } else {
    chosen = everything;
    outName = `${project.id}_full.mp4`;
  }
  if (!chosen.length) throw bad('Nothing to compile.');
  const opts = {
    size: project.settings.size, captions: project.settings.captions,
    placeholders: !!req.body.placeholders,
  };
  if (!opts.placeholders) {
    const missing = chosen.filter(x => !x.scene.asset || !x.scene.audio).map(x => x.scene.id);
    if (missing.length) {
      const e = bad(`${missing.length} scene${missing.length > 1 ? 's are' : ' is'} missing an image or narration: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' and more' : ''}.`);
      e.missing = missing; throw e;
    }
  }
  const overlay = project.settings.overlay && scope !== 'scene' && fs.existsSync(OVERLAY_FILE) ? OVERLAY_FILE : null;

  const job = startJob('compile', project.id, chosen.length + 1, async job => {
    const clips = [];
    for (const { scene } of chosen) {
      job.message = `Building ${scene.id}`;
      const out = await render.renderScene(dirOf(project.id), scene, scene.n - 1, opts);
      clips.push(out.file);
      job.done++;
    }
    job.message = 'Joining scenes';
    await render.joinScenes(dirOf(project.id), clips, outName, { overlay });
    job.done++;
    return { file: outName };
  });
  res.json({ job });
}));

app.get('/api/projects/:id/renders', wrap((req, res) => {
  const dir = path.join(dirOf(loadProject(req.params.id).id), 'renders');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp4')).map(f => {
    const s = fs.statSync(path.join(dir, f));
    return { file: f, size: s.size, modified: s.mtimeMs };
  }).sort((a, b) => b.modified - a.modified);
  res.json({ files });
}));

// ─── Prompt export ───────────────────────────────────────────────────────────
app.get('/api/projects/:id/export', wrap((req, res) => {
  const project = loadProject(req.params.id);
  if (!project.plan) throw bad('Import a plan first.');
  const kind = req.query.kind === 'video' ? 'video' : 'image';
  const actIndex = req.query.act !== undefined && req.query.act !== '' ? parseInt(req.query.act, 10) : null;
  const body = story.exportPrompts(project, { kind, actIndex });
  const suffix = actIndex === null ? 'all' : `act-${actIndex + 1}`;
  res.setHeader('Content-Disposition', `attachment; filename="${project.id}_${kind}-prompts_${suffix}.txt"`);
  res.type('text/plain').send(body);
}));

app.listen(PORT, () => {
  console.log(`\n  Story Studio is running.\n  Open http://localhost:${PORT} in your browser.\n  Keep this window open while you work. Press Ctrl+C to stop.\n`);
});
