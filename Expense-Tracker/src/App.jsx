import { useMemo, useRef, useState } from "react";
import { calculateReceiptSplit, currencySymbols, money } from "./lib/calculations";
import { extractReceiptText } from "./lib/ocr";
import { parseReceiptWithGemini } from "./lib/receiptParser";
import { hasSupabaseConfig, supabase } from "./lib/supabaseClient";

const defaultParticipants = ["Kevin", "Alex", "Jamie", "Taylor"];

function SectionIcon({ children }) {
  return (
    <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
      {children}
    </span>
  );
}

export default function ReceiptSplitApp() {
  const fileInputRef = useRef(null);
  const [participants, setParticipants] = useState(defaultParticipants);
  const [newPerson, setNewPerson] = useState("");
  const [baseCurrency, setBaseCurrency] = useState("EUR");
  const [settlementCurrency, setSettlementCurrency] = useState("USD");
  const [exchangeRate, setExchangeRate] = useState(1.08);
  const [paidBy, setPaidBy] = useState("Kevin");
  const [receiptType, setReceiptType] = useState("restaurant");
  const [taxTip, setTaxTip] = useState(18);
  const [items, setItems] = useState([
    { id: 1, name: "Sangria pitcher", category: "Shared drinks", amount: 28, sharedBy: ["Kevin", "Alex", "Jamie", "Taylor"] },
    { id: 2, name: "Paella", category: "Main course", amount: 42, sharedBy: ["Kevin", "Alex"] },
    { id: 3, name: "Sea bass", category: "Main course", amount: 31, sharedBy: ["Jamie"] },
    { id: 4, name: "Rideshare to hotel", category: "Ride share", amount: 24, sharedBy: ["Kevin", "Alex", "Jamie", "Taylor"] },
  ]);
  const [ocrStatus, setOcrStatus] = useState("Ready for receipt image upload.");
  const [ocrText, setOcrText] = useState("");
  const [receiptMerchant, setReceiptMerchant] = useState("");
  const [saveStatus, setSaveStatus] = useState("");

  const addParticipant = () => {
    const clean = newPerson.trim();
    if (!clean || participants.includes(clean)) return;
    setParticipants([...participants, clean]);
    setNewPerson("");
  };

  const removeParticipant = (name) => {
    setParticipants(participants.filter((p) => p !== name));
    setItems(items.map((item) => ({ ...item, sharedBy: item.sharedBy.filter((p) => p !== name) })));
    if (paidBy === name) {
      const nextPayer = participants.find((p) => p !== name) || "";
      setPaidBy(nextPayer);
    }
  };

  const addItem = () => {
    setItems([
      ...items,
      {
        id: Date.now(),
        name: receiptType === "rideshare" ? "Ride share" : "New item",
        category: receiptType === "rideshare" ? "Ride share" : "Shared",
        amount: 0,
        sharedBy: [...participants],
      },
    ]);
  };

  const updateItem = (id, patch) => {
    setItems(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const toggleShare = (itemId, person) => {
    setItems(
      items.map((item) => {
        if (item.id !== itemId) return item;
        const exists = item.sharedBy.includes(person);
        return {
          ...item,
          sharedBy: exists ? item.sharedBy.filter((p) => p !== person) : [...item.sharedBy, person],
        };
      }),
    );
  };

  const calculations = useMemo(
    () => calculateReceiptSplit({ items, participants, paidBy, taxTip }),
    [items, participants, paidBy, taxTip],
  );

  const convertedSettlements = calculations.settlements.map((settlement) => ({
    ...settlement,
    convertedAmount: settlement.amount * Number(exchangeRate || 1),
  }));

  const handleReceiptUpload = async (event) => {
    const [file] = event.target.files || [];
    if (!file) return;

    setOcrText("");
    setReceiptMerchant("");
    setOcrStatus("Parsing receipt with Gemini...");

    try {
      const parsedReceipt = await parseReceiptWithGemini(file);
      const parsedItems = parsedReceipt.items.map((item, index) => ({
        id: Date.now() + index,
        name: item.name,
        category: item.category,
        amount: item.amount,
        sharedBy: [...participants],
      }));

      if (!parsedItems.length) {
        throw new Error("Gemini did not find itemized receipt rows.");
      }

      setItems(parsedItems);
      setReceiptMerchant(parsedReceipt.merchant);
      setBaseCurrency(currencySymbols[parsedReceipt.currency] ? parsedReceipt.currency : "USD");
      setTaxTip(
        parsedReceipt.subtotal > 0
          ? Number((((parsedReceipt.tax + parsedReceipt.tip) / parsedReceipt.subtotal) * 100).toFixed(2))
          : 0,
      );
      setOcrStatus(`Gemini itemized ${parsedItems.length} receipt item${parsedItems.length === 1 ? "" : "s"}.`);
    } catch (geminiError) {
      setOcrStatus(`Gemini parsing failed: ${geminiError.message}. Running Tesseract OCR fallback...`);
      const text = await extractReceiptText(file, (progress) => {
        setOcrStatus(`Recognizing receipt text: ${progress}%`);
      });
      setOcrText(text);
      setOcrStatus(text ? "Tesseract fallback extracted receipt text." : "No text was detected in that image.");
    } finally {
      event.target.value = "";
    }
  };

  const saveSplit = async () => {
    setSaveStatus("");

    if (!hasSupabaseConfig || !supabase) {
      setSaveStatus("Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel or .env to enable saving.");
      return;
    }

    const payload = {
      receipt_type: receiptType,
      paid_by: paidBy,
      base_currency: baseCurrency,
      settlement_currency: settlementCurrency,
      exchange_rate: Number(exchangeRate || 1),
      tax_tip_percent: Number(taxTip || 0),
      participants,
      items,
      calculations: {
        ...calculations,
        convertedSettlements,
      },
      ocr_text: ocrText,
    };

    const { error } = await supabase.from("receipt_splits").insert(payload);
    setSaveStatus(error ? `Save failed: ${error.message}` : "Split saved to Supabase.");
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 text-left text-slate-900 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 rounded-3xl bg-white p-6 shadow-sm md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-500">Group travel expense splitter</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight">Receipt Split</h1>
            <p className="mt-2 max-w-2xl text-slate-600">
              Upload receipts, itemize shared items, assign main courses, split ride shares, convert currencies, and settle who owes whom.
            </p>
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center justify-center rounded-2xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700"
          >
            Upload receipt
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleReceiptUpload}
          />
        </header>

        <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
          <section className="space-y-6">
            <div className="rounded-3xl bg-white shadow-sm">
              <div className="space-y-4 p-5">
                <div className="flex items-center gap-2">
                  <SectionIcon>PE</SectionIcon>
                  <h2 className="text-xl font-semibold">Participants</h2>
                </div>
                <div className="flex gap-2">
                  <input
                    className="w-full rounded-2xl border px-3 py-2"
                    placeholder="Add person"
                    value={newPerson}
                    onChange={(event) => setNewPerson(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") addParticipant();
                    }}
                  />
                  <button
                    type="button"
                    onClick={addParticipant}
                    className="rounded-2xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700"
                  >
                    Add
                  </button>
                </div>
                <div className="space-y-2">
                  {participants.map((person) => (
                    <div key={person} className="flex items-center justify-between rounded-2xl bg-slate-100 px-3 py-2">
                      <span>{person}</span>
                      <button
                        type="button"
                        onClick={() => removeParticipant(person)}
                        className="rounded-xl px-2 py-1 text-sm text-slate-500 hover:bg-red-50 hover:text-red-600"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-3xl bg-white shadow-sm">
              <div className="space-y-4 p-5">
                <div className="flex items-center gap-2">
                  <SectionIcon>FX</SectionIcon>
                  <h2 className="text-xl font-semibold">Currency</h2>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-sm">
                    Receipt currency
                    <select
                      className="mt-1 w-full rounded-2xl border px-3 py-2"
                      value={baseCurrency}
                      onChange={(event) => setBaseCurrency(event.target.value)}
                    >
                      {Object.keys(currencySymbols).map((currency) => (
                        <option key={currency}>{currency}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm">
                    Settle in
                    <select
                      className="mt-1 w-full rounded-2xl border px-3 py-2"
                      value={settlementCurrency}
                      onChange={(event) => setSettlementCurrency(event.target.value)}
                    >
                      {Object.keys(currencySymbols).map((currency) => (
                        <option key={currency}>{currency}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="block text-sm">
                  Exchange rate
                  <input
                    type="number"
                    step="0.0001"
                    className="mt-1 w-full rounded-2xl border px-3 py-2"
                    value={exchangeRate}
                    onChange={(event) => setExchangeRate(event.target.value)}
                  />
                </label>
                <p className="text-sm text-slate-500">
                  Use a live FX API later; this demo lets the group enter the conversion rate manually.
                </p>
              </div>
            </div>
          </section>

          <main className="space-y-6">
            <div className="rounded-3xl bg-white shadow-sm">
              <div className="space-y-4 p-5">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="flex items-center gap-2">
                    <SectionIcon>{receiptType === "rideshare" ? "RS" : "RC"}</SectionIcon>
                    <h2 className="text-xl font-semibold">Receipt details</h2>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <select
                      className="rounded-2xl border px-3 py-2"
                      value={receiptType}
                      onChange={(event) => setReceiptType(event.target.value)}
                    >
                      <option value="restaurant">Restaurant</option>
                      <option value="groceries">Groceries</option>
                      <option value="rideshare">Ride share</option>
                      <option value="hotel">Hotel / lodging</option>
                      <option value="other">Other</option>
                    </select>
                    <select
                      className="rounded-2xl border px-3 py-2"
                      value={paidBy}
                      onChange={(event) => setPaidBy(event.target.value)}
                    >
                      {participants.map((person) => (
                        <option key={person}>{person}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={addItem}
                      className="rounded-2xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700"
                    >
                      Add item
                    </button>
                  </div>
                </div>

                <div className="rounded-2xl border bg-slate-50 p-3">
                  <p className="text-sm font-medium text-slate-600">OCR / Tesseract</p>
                  <p className="text-sm text-slate-500">{ocrStatus}</p>
                  {receiptMerchant ? (
                    <p className="mt-2 text-sm font-medium text-slate-700">Merchant: {receiptMerchant}</p>
                  ) : null}
                  {ocrText ? (
                    <pre className="mt-3 max-h-36 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-3 text-xs text-slate-600">
                      {ocrText}
                    </pre>
                  ) : null}
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] border-separate border-spacing-y-2">
                    <thead className="text-left text-sm text-slate-500">
                      <tr>
                        <th>Item</th>
                        <th>Category</th>
                        <th>Amount</th>
                        <th>Shared by</th>
                        <th aria-label="Actions"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.id} className="rounded-2xl bg-white shadow-sm">
                          <td className="rounded-l-2xl p-2">
                            <input
                              className="w-full rounded-xl border px-2 py-2"
                              value={item.name}
                              onChange={(event) => updateItem(item.id, { name: event.target.value })}
                            />
                          </td>
                          <td className="p-2">
                            <input
                              className="w-full rounded-xl border px-2 py-2"
                              value={item.category}
                              onChange={(event) => updateItem(item.id, { category: event.target.value })}
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              className="w-28 rounded-xl border px-2 py-2"
                              value={item.amount}
                              onChange={(event) => updateItem(item.id, { amount: event.target.value })}
                            />
                          </td>
                          <td className="p-2">
                            <div className="flex flex-wrap gap-1">
                              {participants.map((person) => (
                                <button
                                  type="button"
                                  key={person}
                                  onClick={() => toggleShare(item.id, person)}
                                  className={`rounded-full px-3 py-1 text-xs ${
                                    item.sharedBy.includes(person) ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
                                  }`}
                                >
                                  {person}
                                </button>
                              ))}
                            </div>
                          </td>
                          <td className="rounded-r-2xl p-2">
                            <button
                              type="button"
                              onClick={() => setItems(items.filter((currentItem) => currentItem.id !== item.id))}
                              className="rounded-xl px-2 py-1 text-sm text-slate-500 hover:bg-red-50 hover:text-red-600"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                  <label className="text-sm">
                    Tax / tip / fees %
                    <input
                      type="number"
                      className="mt-1 w-full rounded-2xl border px-3 py-2"
                      value={taxTip}
                      onChange={(event) => setTaxTip(event.target.value)}
                    />
                  </label>
                  <div className="rounded-2xl bg-slate-100 p-4">
                    <p className="text-sm text-slate-500">Subtotal</p>
                    <p className="text-2xl font-semibold">{money(calculations.subtotal, baseCurrency)}</p>
                  </div>
                  <div className="rounded-2xl bg-slate-900 p-4 text-white">
                    <p className="text-sm text-slate-300">Total</p>
                    <p className="text-2xl font-semibold">{money(calculations.total, baseCurrency)}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-3xl bg-white shadow-sm">
                <div className="space-y-4 p-5">
                  <div className="flex items-center gap-2">
                    <SectionIcon>CA</SectionIcon>
                    <h2 className="text-xl font-semibold">Individual shares</h2>
                  </div>
                  {participants.map((person) => (
                    <div key={person} className="flex items-center justify-between rounded-2xl bg-slate-100 px-4 py-3">
                      <span>{person}</span>
                      <span className="font-semibold">{money(calculations.owedByPerson[person], baseCurrency)}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-3xl bg-white shadow-sm">
                <div className="space-y-4 p-5">
                  <h2 className="text-xl font-semibold">Who owes what</h2>
                  {convertedSettlements.length === 0 ? (
                    <div className="rounded-2xl bg-green-50 p-4 text-green-700">Everyone is settled.</div>
                  ) : (
                    convertedSettlements.map((settlement) => (
                      <div key={`${settlement.from}-${settlement.to}`} className="rounded-2xl border bg-white p-4">
                        <p className="font-medium">
                          {settlement.from} pays {settlement.to}
                        </p>
                        <p className="text-2xl font-bold">{money(settlement.convertedAmount, settlementCurrency)}</p>
                        <p className="text-sm text-slate-500">Original: {money(settlement.amount, baseCurrency)}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-3xl bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-xl font-semibold">Save split</h2>
                  <p className="text-sm text-slate-500">
                    Uses the Vite Supabase environment variables and writes to a `receipt_splits` table when available.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={saveSplit}
                  className="rounded-2xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700"
                >
                  Save to Supabase
                </button>
              </div>
              {saveStatus ? <p className="mt-3 text-sm text-slate-600">{saveStatus}</p> : null}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
