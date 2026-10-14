'use strict';

// Run with Electron, passing a packaged app's Resources directory and fixture PDF.
// Exercises the built office chunk inside the real ASAR plus its unpacked OCR closure.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const resources = process.argv[2];
const fixture = process.argv[3];
if (!resources || !fixture) throw new Error('Usage: electron smoke-ocr-package.cjs Resources fixture.pdf');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stableworker-ocr-package-'));
app.setPath('userData', profile);

app.whenReady().then(async () => {
  try {
    Object.defineProperty(app, 'isPackaged', { value: true });
    Object.defineProperty(process, 'resourcesPath', { value: path.resolve(resources) });
    const archive = path.join(resources, 'app.asar');
    const chunkDir = path.join(archive, 'out', 'main', 'chunks');
    const file = fs.readdirSync(chunkDir).find((name) => /^office-.*\.js$/.test(name));
    assert.ok(file, 'Built office chunk is missing from ASAR');
    const filename = path.join(chunkDir, file);
    const source = fs.readFileSync(filename, 'utf8');
    // The bundle is internal rather than a public library; export only the OCR entry.
    // Suppress its main entry's window/bootstrap callback and isolate all user state.
    const whenReady = app.whenReady;
    app.whenReady = () => new Promise(() => {});
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    try { loaded._compile(source + '\nexports.ocrSmoke = {extractScannedPdf,resolveOcrAssets};', filename); }
    finally { app.whenReady = whenReady; }
    const assets = loaded.exports.ocrSmoke.resolveOcrAssets();
    assert.ok(assets.apiPath.includes('app.asar.unpacked'), 'OCR API must load from unpacked resources');
    assert.ok(assets.workerPath.includes('app.asar.unpacked'), 'Tesseract worker must load outside ASAR');
    assert.equal(assets.langPath, path.join(path.resolve(resources), 'ocr', 'tessdata'));
    const result = await loaded.exports.ocrSmoke.extractScannedPdf(fs.readFileSync(fixture));
    assert.equal(result.pages[0].source, 'text');
    assert.equal(result.pages[1].source, 'ocr');
    assert.ok(result.pages[1].text.replace(/\s/g, '').includes('会议纪要'));
    assert.ok(result.pages[1].text.includes('StableWorker OCR 2026'));
    console.log(JSON.stringify({ packagedOcr: 'passed', totalPages: result.totalPages, ocrPages: result.ocrPages, confidence: result.pages[1].confidence, languagePath: assets.langPath, apiPath: assets.apiPath }));
    fs.rmSync(profile, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.rmSync(profile, { recursive: true, force: true });
    app.exit(1);
  }
});
