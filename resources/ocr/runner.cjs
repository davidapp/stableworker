'use strict';

// This owner thread makes initialization cancellable too: terminating it also
// terminates Tesseract's nested worker. No document or model is fetched online.
const { parentPort, workerData } = require('node:worker_threads');
global.fetch = async () => { throw new Error('Local OCR does not allow network requests'); };
const { createWorker, OEM, PSM } = require(workerData.apiPath);
let worker;
const sendError = (error, id) => parentPort.postMessage({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });

const ready = createWorker(workerData.languages, OEM.LSTM_ONLY, {
  workerPath: workerData.workerPath,
  langPath: workerData.langPath,
  gzip: false,
  cacheMethod: 'none',
  logger: (progress) => parentPort.postMessage({ type: 'progress', status: progress.status, progress: progress.progress }),
  errorHandler: (error) => sendError(error),
}).then(async (value) => {
  worker = value;
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' });
  parentPort.postMessage({ type: 'ready' });
}).catch((error) => { sendError(error); });

parentPort.on('message', async (message) => {
  if (message.type !== 'recognize') return;
  try {
    await ready;
    if (!worker) throw new Error('Local OCR initialization failed');
    const { data } = await worker.recognize(Buffer.from(message.data), { rotateAuto: true }, { text: true });
    parentPort.postMessage({ type: 'result', id: message.id, text: data.text, confidence: data.confidence });
  } catch (error) { sendError(error, message.id); }
});
