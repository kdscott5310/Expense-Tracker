import React, { useMemo, useState } from "react";
import { Upload, Receipt, Users, Car, Plus, Trash2, ArrowRightLeft, Calculator } from "lucide-react";


const currencySymbols = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  CAD: "C$",
  MXN: "MX$",
};

const defaultParticipants = ["Kevin", "Alex", "Jamie", "Taylor"];

function money(value, currency = "USD") {
  const symbol = currencySymbols[currency] || currency + " ";
  return `${symbol}${Number(value || 0).toFixed(2)}`;
}

function splitEvenly(amount, names) {
  if (!names.length) return {};
  const share = amount / names.length;
  return Object.fromEntries(names.map((name) => [name, share]));
}

function simplifyDebts(netByPerson) {
  const debtors = [];
  const creditors = [];

  Object.entries(netByPerson).forEach(([name, amount]) => {
    if (amount < -0.01) debtors.push({ name, amount: -amount });
    if (amount > 0.01) creditors.push({ name, amount });
  });

  const settlements = [];
  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount);
    settlements.push({ from: debtors[i].name, to: creditors[j].name, amount: pay });
    debtors[i].amount -= pay;
    creditors[j].amount -= pay;
    if (debtors[i].amount < 0.01) i++;
    if (creditors[j].amount < 0.01) j++;
  }

  return settlements;
}

export default function ReceiptSplitApp() {
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

  const addParticipant = () => {
    const clean = newPerson.trim();
    if (!clean || participants.includes(clean)) return;
    setParticipants([...participants, clean]);
    setNewPerson("");
  };

  const removeParticipant = (name) => {
    setParticipants(participants.filter((p) => p !== name));
    setItems(items.map((item) => ({ ...item, sharedBy: item.sharedBy.filter((p) => p !== name) })));
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
      })
    );
  };

  const calculations = useMemo(() => {
    const subtotal = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const multiplier = 1 + Number(taxTip || 0) / 100;
    const total = subtotal * multiplier;
    const owedByPerson = Object.fromEntries(participants.map((p) => [p, 0]));

    items.forEach((item) => {
      const participantsForItem = item.sharedBy.length ? item.sharedBy : participants;
      const allocations = splitEvenly(Number(item.amount || 0) * multiplier, participantsForItem);
      Object.entries(allocations).forEach(([person, amount]) => {
        owedByPerson[person] = (owedByPerson[person] || 0) + amount;
      });
    });

    const paidByPerson = Object.fromEntries(participants.map((p) => [p, p === paidBy ? total : 0]));
    const netByPerson = Object.fromEntries(
      participants.map((p) => [p, (paidByPerson[p] || 0) - (owedByPerson[p] || 0)])
    );

    return {
      subtotal,
      total,
      owedByPerson,
      paidByPerson,
      netByPerson,
      settlements: simplifyDebts(netByPerson),
    };
  }, [items, participants, paidBy, taxTip]);

  const convertedSettlements = calculations.settlements.map((s) => ({
    ...s,
    convertedAmount: s.amount * Number(exchangeRate || 1),
  }));

  return (
    </div className="min-h-screen bg-slate-50 p-4 text-slate-900 md:p-8">
      </div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 rounded-3xl bg-white p-6 shadow-sm md:flex-row md:items-center md:justify-between">
          </div>
            <p className="text-sm font-medium text-slate-500">Group travel expense splitter</p>
            <h1 className="text-3xl font-bold tracking-tight">Receipt Split</h1>
            <p className="mt-2 max-w-2xl text-slate-600">
              Upload receipts, itemize shared items, assign main courses, split ride shares, convert currencies, and settle who owes whom.
            </p>
          </div>
          <button className="rounded-2xl">
            <Upload className="mr-2 h-4 w-4" /> Upload receipt
          </button>
        </header>

        <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
          <section className="space-y-6">
           <div className="rounded-3xl bg-white shadow-sm">
              <div className="space-y-4 p-5">
                <div className="flex items-center gap-2">
                  <Users className="h-5 w-5" />
                  <h2 className="text-xl font-semibold">Participants</h2>
                </div>
                <div className="flex gap-2">
                  <input
                    className="w-full rounded-2xl border px-3 py-2"
                    placeholder="Add person"
                    value={newPerson}
                    onChange={(e) => setNewPerson(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addParticipant()}
                  />
                  <button onClick={addParticipant} className="rounded-2xl"><Plus className="h-4 w-4" /></Button>
                </div>
                <div className="space-y-2">
                  {participants.map((person) => (
                    <div key={person} className="flex items-center justify-between rounded-2xl bg-slate-100 px-3 py-2">
                      <span>{person}</span>
                      <button onClick={() => removeParticipant(person)} className="text-slate-400 hover:text-red-500">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            div className="rounded-3xl shadow-sm">
              <divContent className="space-y-4 p-5">
                <div className="flex items-center gap-2">
                  <ArrowRightLeft className="h-5 w-5" />
                  <h2 className="text-xl font-semibold">Currency</h2>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-sm">Receipt currency
                    <select className="mt-1 w-full rounded-2xl border px-3 py-2" value={baseCurrency} onChange={(e) => setBaseCurrency(e.target.value)}>
                      {Object.keys(currencySymbols).map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </label>
                  <label className="text-sm">Settle in
                    <select className="mt-1 w-full rounded-2xl border px-3 py-2" value={settlementCurrency} onChange={(e) => setSettlementCurrency(e.target.value)}>
                      {Object.keys(currencySymbols).map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </label>
                </div>
                <label className="block text-sm">Exchange rate
                  <input
                    type="number"
                    step="0.0001"
                    className="mt-1 w-full rounded-2xl border px-3 py-2"
                    value={exchangeRate}
                    onChange={(e) => setExchangeRate(e.target.value)}
                  />
                </label>
                <p className="text-sm text-slate-500">Use a live FX API later; this demo lets the group enter the conversion rate manually.</p>
              </divContent>
            </div>
          </section>

          <main className="space-y-6">
            div className="rounded-3xl shadow-sm">
              <divContent className="space-y-4 p-5">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="flex items-center gap-2">
                    {receiptType === "rideshare" ? <Car className="h-5 w-5" /> : <Receipt className="h-5 w-5" />}
                    <h2 className="text-xl font-semibold">Receipt details</h2>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <select className="rounded-2xl border px-3 py-2" value={receiptType} onChange={(e) => setReceiptType(e.target.value)}>
                      <option value="restaurant">Restaurant</option>
                      <option value="groceries">Groceries</option>
                      <option value="rideshare">Ride share</option>
                      <option value="hotel">Hotel / lodging</option>
                      <option value="other">Other</option>
                    </select>
                    <select className="rounded-2xl border px-3 py-2" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
                      {participants.map((p) => <option key={p}>{p}</option>)}
                    </select>
                    <button onClick={addItem} className="rounded-2xl"><Plus className="mr-2 h-4 w-4" /> Add item</Button>
                  </div>
                </div>

                <div className="rounded-2xl border bg-slate-50 p-3">
                  <p className="text-sm font-medium text-slate-600">OCR placeholder</p>
                  <p className="text-sm text-slate-500">
                    Connect this upload area to Google Vision, OpenAI vision, or Tesseract to scan receipts and auto-create item rows.
                  </p>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] border-separate border-spacing-y-2">
                    <thead className="text-left text-sm text-slate-500">
                      <tr>
                        <th>Item</th>
                        <th>Category</th>
                        <th>Amount</th>
                        <th>Shared by</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.id} className="rounded-2xl bg-white shadow-sm">
                          <td className="rounded-l-2xl p-2">
                            <input className="w-full rounded-xl border px-2 py-2" value={item.name} onChange={(e) => updateItem(item.id, { name: e.target.value })} />
                          </td>
                          <td className="p-2">
                            <input className="w-full rounded-xl border px-2 py-2" value={item.category} onChange={(e) => updateItem(item.id, { category: e.target.value })} />
                          </td>
                          <td className="p-2">
                            <input type="number" className="w-28 rounded-xl border px-2 py-2" value={item.amount} onChange={(e) => updateItem(item.id, { amount: e.target.value })} />
                          </td>
                          <td className="p-2">
                            <div className="flex flex-wrap gap-1">
                              {participants.map((person) => (
                                <button
                                  key={person}
                                  onClick={() => toggleShare(item.id, person)}
                                  className={`rounded-full px-3 py-1 text-xs ${item.sharedBy.includes(person) ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}
                                >
                                  {person}
                                </button>
                              ))}
                            </div>
                          </td>
                          <td className="rounded-r-2xl p-2">
                            <button onClick={() => setItems(items.filter((i) => i.id !== item.id))} className="text-slate-400 hover:text-red-500">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                  <label className="text-sm">Tax / tip / fees %
                    <input type="number" className="mt-1 w-full rounded-2xl border px-3 py-2" value={taxTip} onChange={(e) => setTaxTip(e.target.value)} />
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
              <div className="rounded-3xl shadow-sm">
                <divContent className="space-y-4 p-5">
                  <div className="flex items-center gap-2">
                    <Calculator className="h-5 w-5" />
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

              <div className="rounded-3xl shadow-sm">
                <divContent className="space-y-4 p-5">
                  <h2 className="text-xl font-semibold">Who owes what</h2>
                  {convertedSettlements.length === 0 ? (
                    <div className="rounded-2xl bg-green-50 p-4 text-green-700">Everyone is settled.</div>
                  ) : (
                    convertedSettlements.map((s, index) => (
                      <div key={index} className="rounded-2xl border bg-white p-4">
                        <p className="font-medium">
                          {s.from} pays {s.to}
                        </p>
                        <p className="text-2xl font-bold">{money(s.convertedAmount, settlementCurrency)}</p>
                        <p className="text-sm text-slate-500">Original: {money(s.amount, baseCurrency)}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
