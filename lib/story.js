// Story engine: script splitting, the planning prompt, plan validation,
// and the prompt compiler that keeps characters and locations consistent.

const SHOTS = ['Wide shot', 'Medium shot', 'Close-up', 'Over-the-shoulder shot', 'Detail shot'];
const HOOK_SCENES = 8;        // the first scenes move faster
const HOOK_MAX_WORDS = 50;
const BODY_MAX_WORDS = 90;
const SPLIT_ABOVE = 1.45;     // a scene this many times over its limit is split automatically

const ABBREVIATIONS = /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|No|Gen|Col|Lt|Sgt|Rev|Hon|Capt|Cmdr|Inc|Ltd|Co)\.$/;

function wordCount(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

// Splits a script into sentences without changing a single word.
// Joining the result with single spaces gives back the script (whitespace aside).
function splitSentences(script) {
  const out = [];
  const paragraphs = String(script || '').replace(/\r/g, '').split(/\n+/).map(p => p.trim()).filter(Boolean);
  paragraphs.forEach((para, pIndex) => {
    const tokens = para.split(/\s+/);
    let current = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      current.push(tok);
      const next = tokens[i + 1];
      const endsSentence = /[.!?…]["'”’)\]]*$/.test(tok) && !ABBREVIATIONS.test(tok) && !/^[A-Z]\.$/.test(tok);
      const nextStarts = !next || /^["'“‘(\[]?[A-Z0-9]/.test(next);
      if (endsSentence && nextStarts) {
        out.push({ text: current.join(' '), paragraph: pIndex });
        current = [];
      }
    }
    if (current.length) out.push({ text: current.join(' '), paragraph: pIndex });
  });
  return out.map((s, i) => ({ n: i + 1, text: s.text, paragraph: s.paragraph, words: wordCount(s.text) }));
}

function slugify(value, fallback) {
  const s = String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback || 'item';
}

// ─── The prompt the user runs in Claude or Gemini ────────────────────────────
function buildPlannerPrompt(project) {
  const sentences = project.sentences || [];
  const total = sentences.length;
  const numbered = sentences.map(s => `[${s.n}] ${s.text}`).join('\n');
  const words = sentences.reduce((a, s) => a + s.words, 0);
  const targetScenes = Math.max(6, Math.round(words / 65));

  return `You are the story analyst and art director for a narrated YouTube story channel. I will give you a script whose sentences are numbered. Plan the visuals for it and reply with ONE JSON object and nothing else.

The narration is already fixed. Do not rewrite, quote or return any script text. You only decide where each scene starts and ends (by sentence number) and what the viewer sees.

WHAT TO RETURN

{
  "title": "short working title",
  "style": "one sentence that fixes the look of the whole film: medium, lens feel, colour grade, mood",
  "characters": [
    {
      "id": "short-lowercase-id",
      "name": "Name as used in the script",
      "role": "Protagonist | Antagonist | Supporting | Flashback",
      "anchor": "LOCKED LOOK, 40 to 70 words",
      "wardrobe": [ { "id": "short-id", "label": "2-3 word label", "description": "one outfit, 15 to 30 words" } ]
    }
  ],
  "locations": [
    { "id": "short-lowercase-id", "name": "Short name", "anchor": "LOCKED LOOK, 30 to 50 words" }
  ],
  "acts": [
    {
      "title": "Act 1: A dramatic title",
      "scenes": [
        {
          "from": 1,
          "to": 3,
          "location": "location id",
          "characters": [ { "id": "character id", "wardrobe": "wardrobe id" } ],
          "action": "one present-tense sentence describing exactly what is visible",
          "emotion": "visible expression and body language, a few words",
          "shot": "Wide shot | Medium shot | Close-up | Over-the-shoulder shot | Detail shot",
          "lighting": "time of day and light quality, a few words",
          "motion": "for video: what moves in the frame and how the camera moves, one short sentence"
        }
      ]
    }
  ]
}

RULES FOR CHARACTERS
1. List every character who appears on screen in more than one scene, plus anyone the plot turns on.
2. The anchor describes only what a camera can see: apparent age, ethnicity and skin tone, face shape, eyes, nose, hair (style, colour, length), height and build, and any distinguishing mark. Use what the script states and fill the gaps with specific, believable choices. Be concrete: "shoulder-length grey locs tied back" and never "neat hair".
3. No names, personality words, professions, clothing or actions inside an anchor. Clothing goes in wardrobe.
4. Give each character one to three outfits that fit the story. The first outfit is their default.
5. If a character appears at a clearly different age (a flashback, a time jump), create a separate character entry for that age, for example "enid-young" and "enid-old".

RULES FOR LOCATIONS
6. One entry per distinct place. Reuse the same id every time the story returns there.
7. The anchor describes architecture, materials, colours and two or three signature props. No people and no weather.

RULES FOR SCENES
8. Scenes cover the script in order with no gaps and no overlaps: the first scene starts at sentence 1, each scene starts one sentence after the previous scene ends, and the last scene ends at sentence ${total}.
9. A scene is one image on screen. Start a new scene when the place, the moment or the focus of the picture changes.
10. Pacing: the first ${HOOK_SCENES} scenes cover at most ${HOOK_MAX_WORDS} words each. Every later scene covers at most ${BODY_MAX_WORDS} words. This script is ${words} words, so aim for about ${targetScenes} scenes.
11. Group scenes into 3 to 12 acts that follow the story's turning points. Aim for 8 to 14 scenes per act.
12. "characters" lists only the people visible in that image, using ids from your characters list. Use an empty list for scenes with no people.
13. "action" must be something a still image can show. Turn thoughts and backstory into a visible moment. Use character names in the action.
14. Vary the shot from scene to scene. Never use the same shot three times in a row.
15. Keep wardrobe continuous: a character keeps the same outfit until the story gives a reason to change.
16. Never ask for on-screen text, captions, logos or split screens.

OUTPUT FORMAT
Reply with the JSON object only. Start with { and end with }. No markdown fences, no commentary before or after.

THE SCRIPT (${total} numbered sentences, ${words} words)

${numbered}
`;
}

// ─── Reading the model's reply ───────────────────────────────────────────────
function extractJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('No JSON object found. Paste the full reply, starting with { and ending with }.');
  }
  const body = t.slice(first, last + 1);
  try {
    return JSON.parse(body);
  } catch (e) {
    // Common slips: smart quotes around keys, trailing commas.
    const repaired = body.replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(repaired); } catch (e2) {
      throw new Error('The reply is not valid JSON (' + e.message + '). It was probably cut off. Ask the AI to "continue from where you stopped" or to resend the full JSON.');
    }
  }
}

function normalizeShot(value, index) {
  const v = String(value || '').toLowerCase();
  if (v.includes('over')) return 'Over-the-shoulder shot';
  if (v.includes('detail') || v.includes('macro') || v.includes('insert')) return 'Detail shot';
  if (v.includes('close')) return 'Close-up';
  if (v.includes('wide') || v.includes('establish')) return 'Wide shot';
  if (v.includes('medium') || v.includes('mid')) return 'Medium shot';
  return SHOTS[index % SHOTS.length];
}

function sceneId(actIndex, n) {
  return `A${actIndex + 1}S${String(n).padStart(3, '0')}`;
}

// Turns the model's reply into a clean plan. Fixes what can be fixed safely
// and reports the rest as warnings in plain language.
function normalizePlan(raw, sentences) {
  const warnings = [];
  const total = sentences.length;
  if (!raw || typeof raw !== 'object') throw new Error('The reply is empty.');
  if (!Array.isArray(raw.acts) || !raw.acts.length) throw new Error('The reply has no acts. Ask the AI to resend the full JSON.');

  const usedIds = new Set();
  const uniqueId = (wanted, fallback) => {
    let base = slugify(wanted, fallback);
    let id = base, i = 2;
    while (usedIds.has(id)) id = `${base}-${i++}`;
    usedIds.add(id);
    return id;
  };

  const charMap = {};   // any spelling the model used -> final id
  const characters = (Array.isArray(raw.characters) ? raw.characters : []).map((c, i) => {
    const id = uniqueId(c.id || c.name, `character-${i + 1}`);
    [c.id, c.name, id].filter(Boolean).forEach(k => { charMap[String(k).toLowerCase()] = id; charMap[slugify(k)] = id; });
    let wardrobe = Array.isArray(c.wardrobe) ? c.wardrobe : [];
    if (!wardrobe.length && c.clothing) wardrobe = [{ id: 'default', label: 'Default', description: c.clothing }];
    if (!wardrobe.length) {
      wardrobe = [{ id: 'default', label: 'Default', description: '' }];
      warnings.push(`${c.name || id} has no outfit. Add one on the Cast tab so their clothes stay the same.`);
    }
    const seen = new Set();
    wardrobe = wardrobe.map((w, wi) => {
      let wid = slugify(w.id || w.label, `outfit-${wi + 1}`);
      while (seen.has(wid)) wid += '-x';
      seen.add(wid);
      return { id: wid, label: String(w.label || w.id || `Outfit ${wi + 1}`), description: String(w.description || '').trim() };
    });
    const anchor = String(c.anchor || c.physicalDescription || '').trim();
    if (wordCount(anchor) < 15) warnings.push(`${c.name || id}'s locked look is very short (${wordCount(anchor)} words). Add face, hair and build details on the Cast tab.`);
    return { id, name: String(c.name || id), role: String(c.role || 'Supporting'), anchor, wardrobe, refImage: null };
  });

  usedIds.clear();
  const locMap = {};
  const locations = (Array.isArray(raw.locations) ? raw.locations : []).map((l, i) => {
    const id = uniqueId(l.id || l.name, `location-${i + 1}`);
    [l.id, l.name, id].filter(Boolean).forEach(k => { locMap[String(k).toLowerCase()] = id; locMap[slugify(k)] = id; });
    return { id, name: String(l.name || id), anchor: String(l.anchor || l.description || '').trim(), refImage: null };
  });

  const resolve = (map, value) => {
    if (!value) return null;
    return map[String(value).toLowerCase()] || map[slugify(value)] || null;
  };

  // Flatten, order and repair coverage.
  let flat = [];
  raw.acts.forEach((act, ai) => {
    (Array.isArray(act.scenes) ? act.scenes : []).forEach(sc => {
      const from = parseInt(sc.from, 10), to = parseInt(sc.to, 10);
      if (!Number.isFinite(from)) return;
      flat.push({ ...sc, from, to: Number.isFinite(to) ? to : from, _act: ai });
    });
  });
  if (!flat.length) throw new Error('The reply has no scenes with sentence numbers.');
  flat.sort((a, b) => a.from - b.from || a._act - b._act);

  let repaired = 0;
  let cursor = 1;
  const ordered = [];
  flat.forEach((sc, i) => {
    if (cursor > total) return;          // the model ran past the end of the script
    const from = cursor;
    const next = flat[i + 1];
    // A scene runs until the sentence before the next scene starts.
    const to = next ? Math.max(from, Math.min(total, next.from - 1)) : total;
    if (from !== sc.from || to !== sc.to) repaired++;
    ordered.push({ ...sc, from, to });
    cursor = to + 1;
  });
  if (ordered.length && ordered[ordered.length - 1].to < total) {
    ordered[ordered.length - 1].to = total; repaired++;
  }
  if (repaired) warnings.push(`${repaired} scene boundaries did not line up and were adjusted so every sentence is narrated exactly once.`);

  // Split scenes that run far past the pacing limit.
  const wordsBetween = (from, to) => { let w = 0; for (let n = from; n <= to; n++) w += sentences[n - 1].words; return w; };
  let autoSplit = 0;
  const paced = [];
  ordered.forEach(sc => {
    const limit = paced.length < HOOK_SCENES ? HOOK_MAX_WORDS : BODY_MAX_WORDS;
    const w = wordsBetween(sc.from, sc.to);
    if (w <= limit * SPLIT_ABOVE || sc.from === sc.to) { paced.push(sc); return; }
    let start = sc.from, acc = 0, part = 0;
    for (let n = sc.from; n <= sc.to; n++) {
      const sw = sentences[n - 1].words;
      if (acc > 0 && acc + sw > limit) {
        paced.push({ ...sc, from: start, to: n - 1, _part: part++ });
        start = n; acc = 0;
      }
      acc += sw;
    }
    paced.push({ ...sc, from: start, to: sc.to, _part: part });
    autoSplit += part;
  });
  if (autoSplit) warnings.push(`${autoSplit} long scenes were split to keep the picture changing. The new parts reuse the same setting with a different shot. Check them on the Scenes tab.`);

  // Rebuild acts with ids.
  const acts = raw.acts.map((a, i) => ({ title: String(a.act || a.title || `Act ${i + 1}`), scenes: [] }));
  let unknownChars = new Set(), unknownLocs = new Set(), lastLoc = locations[0] ? locations[0].id : null;
  paced.forEach((sc, idx) => {
    const n = idx + 1;
    let loc = resolve(locMap, sc.location);
    if (!loc) { if (sc.location) unknownLocs.add(String(sc.location)); loc = lastLoc; }
    lastLoc = loc;
    const cast = (Array.isArray(sc.characters) ? sc.characters : []).map(entry => {
      const ref = typeof entry === 'string' ? { id: entry } : (entry || {});
      const id = resolve(charMap, ref.id || ref.name);
      if (!id) { if (ref.id || ref.name) unknownChars.add(String(ref.id || ref.name)); return null; }
      const ch = characters.find(c => c.id === id);
      const wid = slugify(ref.wardrobe || '');
      const outfit = ch.wardrobe.find(w => w.id === wid) || ch.wardrobe[0];
      return { id, wardrobe: outfit.id };
    }).filter(Boolean);
    let shot = normalizeShot(sc.shot, idx);
    if (sc._part) shot = SHOTS[(SHOTS.indexOf(shot) + sc._part) % SHOTS.length];
    acts[sc._act].scenes.push({
      id: sceneId(sc._act, n), n, from: sc.from, to: sc.to,
      location: loc, characters: cast,
      action: String(sc.action || sc.description || '').trim(),
      emotion: String(sc.emotion || '').trim(),
      shot, lighting: String(sc.lighting || '').trim(),
      motion: String(sc.motion || '').trim(),
      autoSplit: !!sc._part,
      asset: null, audio: null,
    });
  });
  if (unknownChars.size) warnings.push(`Scenes mention characters that are not in the cast list: ${[...unknownChars].join(', ')}. They were left out of those prompts.`);
  if (unknownLocs.size) warnings.push(`Scenes mention locations that are not in the location list: ${[...unknownLocs].join(', ')}. The previous location was used instead.`);

  const finalActs = acts.filter(a => a.scenes.length);
  finalActs.forEach((a, ai) => a.scenes.forEach(s => { s.id = sceneId(ai, s.n); }));

  return {
    plan: {
      title: String(raw.title || '').trim(),
      style: String(raw.style || 'Photorealistic cinematic drama still, natural skin texture, shallow depth of field, soft filmic colour grade').trim(),
      characters, locations, acts: finalActs,
    },
    warnings,
  };
}

// ─── Prompt compiler ─────────────────────────────────────────────────────────
// Every prompt is assembled from the locked anchors at the moment it is shown,
// so editing a character once updates every scene they appear in.
const clean = s => String(s || '').trim().replace(/\s+/g, ' ').replace(/[.\s]+$/, '');
const NEGATIVE = 'No on-screen text, captions, subtitles, watermarks or logos.';

function characterLine(plan, entry) {
  const ch = plan.characters.find(c => c.id === entry.id);
  if (!ch) return null;
  const outfit = ch.wardrobe.find(w => w.id === entry.wardrobe) || ch.wardrobe[0];
  const wearing = outfit && clean(outfit.description) ? `, wearing ${clean(outfit.description)}` : '';
  return `${ch.name}: ${clean(ch.anchor)}${wearing}.`;
}

function sceneNarration(sentences, scene) {
  return sentences.slice(scene.from - 1, scene.to).map(s => s.text).join(' ');
}

function compileScene(plan, scene) {
  const loc = plan.locations.find(l => l.id === scene.location);
  const people = scene.characters.map(e => characterLine(plan, e)).filter(Boolean);
  const refs = scene.characters.map(e => plan.characters.find(c => c.id === e.id)).filter(Boolean).map(c => c.name);

  const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
  const lead = [clean(scene.action), clean(scene.emotion)].filter(Boolean).map(cap).join('. ');
  const shared = [];
  if (people.length) shared.push(`Characters (keep each exactly as described): ${people.join(' ')}`);
  else shared.push('No named characters in frame.');
  if (loc) shared.push(`Setting: ${clean(loc.anchor)}.`);
  if (clean(scene.lighting)) shared.push(`Lighting: ${clean(scene.lighting)}.`);
  shared.push(`Style: ${clean(plan.style)}. 16:9 widescreen.`);

  const image = [`${scene.shot}. ${lead}.`, ...shared, NEGATIVE].join('\n');
  const motion = clean(scene.motion) || 'Subtle natural movement, slow gentle camera push-in';
  const video = [
    `${scene.shot}. ${lead}.`,
    `Motion: ${motion}.`,
    ...shared,
    'Audio: quiet natural ambient sound only. No dialogue, no voice-over, no music.',
    NEGATIVE,
  ].join('\n');

  return { image, video, references: refs.concat(loc ? [loc.name] : []) };
}

function compileCharacterRefs(plan, ch) {
  const outfit = ch.wardrobe[0];
  const wearing = outfit && clean(outfit.description) ? `Wearing ${clean(outfit.description)}.` : '';
  const base = `${clean(ch.anchor)}. ${wearing}`.trim();
  return {
    portrait: [
      'Character reference portrait, head and shoulders, facing the camera, neutral relaxed expression.',
      base,
      'Plain light grey studio background, soft even lighting, sharp focus on the face.',
      `Style: ${clean(plan.style)}.`,
      NEGATIVE,
    ].join('\n'),
    fullBody: [
      'Character reference, full body from head to shoes, standing straight, facing the camera, arms relaxed.',
      base,
      'Plain light grey studio background, soft even lighting.',
      `Style: ${clean(plan.style)}.`,
      NEGATIVE,
    ].join('\n'),
  };
}

function compileLocationRef(plan, loc) {
  return [
    'Wide establishing shot of an empty location, no people.',
    `${clean(loc.anchor)}.`,
    'Soft neutral daylight.',
    `Style: ${clean(plan.style)}. 16:9 widescreen.`,
    NEGATIVE,
  ].join('\n');
}

// Adds compiled prompts and narration to a project for the interface.
function hydrate(project) {
  const out = JSON.parse(JSON.stringify(project));
  out.stats = {
    sentences: (project.sentences || []).length,
    words: (project.sentences || []).reduce((a, s) => a + s.words, 0),
  };
  delete out.script;
  delete out.sentences;
  if (!project.plan) return out;
  const plan = out.plan;
  plan.characters.forEach(c => { c.prompts = compileCharacterRefs(plan, c); });
  plan.locations.forEach(l => { l.prompt = compileLocationRef(plan, l); });
  let scenes = 0;
  plan.acts.forEach(act => act.scenes.forEach(sc => {
    scenes++;
    sc.narration = sceneNarration(project.sentences, sc);
    sc.words = wordCount(sc.narration);
    sc.prompts = compileScene(plan, sc);
  }));
  out.stats.scenes = scenes;
  return out;
}

function exportPrompts(project, { kind = 'image', actIndex = null } = {}) {
  const plan = project.plan;
  const lines = [];
  const rule = '='.repeat(60);
  if (actIndex === null) {
    lines.push(rule, 'CHARACTER REFERENCE PORTRAITS', rule, '');
    plan.characters.forEach(c => { lines.push(`### ${c.name}`, compileCharacterRefs(plan, c).portrait, ''); });
    lines.push(rule, 'LOCATION REFERENCES', rule, '');
    plan.locations.forEach(l => { lines.push(`### ${l.name}`, compileLocationRef(plan, l), ''); });
  }
  plan.acts.forEach((act, ai) => {
    if (actIndex !== null && ai !== actIndex) return;
    lines.push(rule, act.title.toUpperCase(), rule, '');
    act.scenes.forEach(sc => {
      const p = compileScene(plan, sc);
      lines.push(`### ${sc.id}`, kind === 'video' ? p.video : p.image, '');
    });
  });
  return lines.join('\n');
}

module.exports = {
  SHOTS, splitSentences, wordCount, slugify, buildPlannerPrompt, extractJson, normalizePlan,
  compileScene, compileCharacterRefs, compileLocationRef, sceneNarration, hydrate, exportPrompts,
};
