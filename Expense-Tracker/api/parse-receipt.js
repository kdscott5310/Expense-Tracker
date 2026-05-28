import { GoogleGenAI } from "@google/genai";

const receiptSchema = {
  type: "object",
  additionalProperties: false,
  required: ["merchant", "currency", "subtotal", "tax", "tip", "total", "items"],
  properties: {
    merchant: { type: "string" },
    currency: { type: "string" },
    subtotal: { type: "number" },
    tax: { type: "number" },
    tip: { type: "number" },
    total: { type: "number" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "category", "amount"],
        properties: {
          name: { type: "string" },
          category: { type: "string" },
          amount: { type: "number" },
        },
      },
    },
  },
};

function normalizeReceipt(receipt) {
  return {
    merchant: receipt.merchant || "",
    currency: receipt.currency || "USD",
    subtotal: Number(receipt.subtotal || 0),
    tax: Number(receipt.tax || 0),
    tip: Number(receipt.tip || 0),
    total: Number(receipt.total || 0),
    items: Array.isArray(receipt.items)
      ? receipt.items.map((item) => ({
          name: item.name || "Receipt item",
          category: item.category || "Receipt item",
          amount: Number(item.amount || 0),
        }))
      : [],
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY server environment variable" });
  }

  try {
    const { imageBase64, mimeType = "image/jpeg" } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: "Missing imageBase64" });
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Parse this receipt image. Extract merchant, currency, subtotal, tax, tip, total, and itemized purchased items. " +
                "Use numbers for money values. Do not include payment card lines, authorization lines, duplicate totals, or receipt metadata as items.",
            },
            {
              inlineData: {
                mimeType,
                data: imageBase64,
              },
            },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseJsonSchema: receiptSchema,
      },
    });

    const parsed = JSON.parse(response.text || "{}");
    return res.status(200).json(normalizeReceipt(parsed));
  } catch (error) {
    return res.status(500).json({ error: error.message || "Gemini receipt parsing failed" });
  }
}
