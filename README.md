# Story Studio

Script in, consistent Google Flow prompts out, narrated video compiled on this computer.

## Start it

Double-click **Start Story Studio.command**. A Terminal window opens and your browser goes to http://localhost:3100. Keep the Terminal window open while you work.

The first start copies Node, ffmpeg and the narrator voice from the previous system's folder, which takes about a minute.

If macOS will not open the file, open Terminal and run:

    bash "/Users/ayodeji/Documents/ME/PROJECTS/Story Studio/Start Story Studio.command"

## The six steps

1. **Script.** Paste the finished narration and create a project.
2. **Plan.** Copy the planning prompt into Claude or Gemini, then paste the reply back. The AI only returns sentence numbers and visual notes, so your narration stays word for word.
3. **Cast and places.** Each character and location has a locked look. It is inserted word for word into every scene prompt. Generate each portrait in Flow first, save it here, and attach it as a reference image in Flow for every scene that character is in.
4. **Scenes.** Copy the image or video prompt for a scene, generate it in Flow, and drop the result on the scene. Name downloads with the scene code (A1S001.png) to place many at once.
5. **Narration.** Pick a voice and voice every scene. Each clip's length sets how long its picture stays on screen.
6. **Compile.** Build one scene, one act or the full film, then download it.

## Where things are

- `projects/<story>/assets` holds the pictures and clips you added
- `projects/<story>/audio` holds the narration
- `projects/<story>/renders` holds the finished videos
- `bin` and `node_modules` were copied from the previous system (Node, ffmpeg, the Kokoro voice)

## Changing the rules

- Pacing limits and the planning prompt: `lib/story.js`
- How a scene prompt is assembled: `compileScene` in `lib/story.js`
- Zoom, captions and output quality: `lib/render.js`

## Stop it

Double-click **Stop Story Studio.command**, or close the Terminal window.

## Back up the code to GitHub

Double-click **Back up to GitHub.command**. The first time it asks for the address of an empty private repo. Images, audio and videos in the projects folder are never uploaded. Copy finished project folders to an external drive or cloud storage yourself.
