const maxImageSide = 1600;
const jpegQuality = 0.75;
const maxBase64Bytes = 3_500_000;
const maxPdfBytes = 3_000_000;

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Unable to compress receipt image"));
    }, type, quality);
  });
}

async function compressReceiptImage(file) {
  const image = new Image();
  const objectUrl = URL.createObjectURL(file);

  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("Unable to load receipt image"));
      image.src = objectUrl;
    });

    const scale = Math.min(1, maxImageSide / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));

    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return canvasToBlob(canvas, "image/jpeg", jpegQuality);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Unable to read receipt image"));
    reader.readAsDataURL(blob);
  });
}

async function parseReceipt(payload) {
  const response = await fetch("/api/parse-receipt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || `Receipt parser returned HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(data.error || "Gemini receipt parsing failed");
  }

  return data;
}

export async function parseReceiptTextWithGemini(receiptText) {
  return parseReceipt({ receiptText });
}

export async function parseReceiptImageWithGemini(file) {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    if (file.size > maxPdfBytes) {
      throw new Error("PDF receipt is too large. Try downloading a smaller receipt PDF or screenshotting/cropping it first.");
    }

    const pdfBase64 = await blobToBase64(file);
    return parseReceipt({
      imageBase64: pdfBase64,
      mimeType: "application/pdf",
    });
  }

  const imageBlob = await compressReceiptImage(file);
  const imageBase64 = await blobToBase64(imageBlob);

  if (imageBase64.length > maxBase64Bytes) {
    throw new Error("Receipt image is still too large after compression. Try cropping closer to the receipt.");
  }

  return parseReceipt({
    imageBase64,
    mimeType: "image/jpeg",
  });
}
