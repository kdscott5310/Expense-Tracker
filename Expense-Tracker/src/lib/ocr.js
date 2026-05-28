export async function extractReceiptText(file, onProgress) {
  if (!file) return "";

  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    logger: (message) => {
      if (message.status === "recognizing text" && typeof onProgress === "function") {
        onProgress(Math.round((message.progress || 0) * 100));
      }
    },
  });

  try {
    const {
      data: { text },
    } = await worker.recognize(file);
    return text.trim();
  } finally {
    await worker.terminate();
  }
}
