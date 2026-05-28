function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Unable to read receipt image"));
    reader.readAsDataURL(file);
  });
}

export async function parseReceiptWithGemini(file) {
  const imageBase64 = await fileToBase64(file);
  const response = await fetch("/api/parse-receipt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      imageBase64,
      mimeType: file.type || "image/jpeg",
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Gemini receipt parsing failed");
  }

  return data;
}
