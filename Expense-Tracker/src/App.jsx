import { useEffect, useMemo, useRef, useState } from "react";
import { calculateReceiptSplit, currencySymbols, money, simplifyDebts } from "./lib/calculations";
import { extractReceiptText } from "./lib/ocr";
import { getProjectIdFromUrl, loadProjectFromSupabase, saveProjectToSupabase, setProjectIdInUrl } from "./lib/projectStore";
import { parseReceiptImageWithGemini, parseReceiptTextWithGemini } from "./lib/receiptParser";
import { hasSupabaseConfig, supabase } from "./lib/supabaseClient";

const storageKey = "receipt-split-project-v1";
const defaultParticipants = ["Kevin", "Alex", "Jamie", "Taylor"];

const sampleItems = [
  { id: crypto.randomUUID(), name: "Sangria pitcher", category: "Shared drinks", amount: 28, sharedBy: ["Kevin", "Alex", "Jamie", "Taylor"] },
  { id: crypto.randomUUID(), name: "Paella", category: "Main course", amount: 42, sharedBy: ["Kevin", "Alex"] },
  { id: crypto.randomUUID(), name: "Sea bass", category: "Main course", amount: 31, sharedBy: ["Jamie"] },
  { id: crypto.randomUUID(), name: "Rideshare to hotel", category: "Ride share", amount: 24, sharedBy: ["Kevin", "Alex", "Jamie", "Taylor"] },
];

function createReceipt(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    place: overrides.place || "Barcelona dinner",
    merchant: overrides.merchant || "",
    receiptType: overrides.receiptType || "restaurant",
    paidBy: overrides.paidBy || "Kevin",
    baseCurrency: overrides.baseCurrency || "EUR",
    taxTip: overrides.taxTip ?? 18,
    items: overrides.items || sampleItems.map((item) => ({ ...item, id: crypto.randomUUID(), sharedBy: [...item.sharedBy] })),
    ocrText: overrides.ocrText || "",
    ocrStatus: overrides.ocrStatus || "Ready for receipt image upload.",
  };
}

function createInitialProject() {
  return {
    id: crypto.randomUUID(),
    name: "Barcelona trip",
    participants: defaultParticipants,
    settlementCurrency: "USD",
    exchangeRate: 1.08,
    receipts: [createReceipt()],
  };
}

function loadInitialProject() {
  if (typeof window === "undefined") return createInitialProject();

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return createInitialProject();
    const parsed = JSON.parse(stored);
    if (!parsed.receipts?.length) return createInitialProject();
    return parsed;
  } catch {
    return createInitialProject();
  }
}

function SectionIcon({ children }) {
  return (
    <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
      {children}
    </span>
  );
}

function calculateProjectSplit(project) {
  const owedByPerson = Object.fromEntries(project.participants.map((person) => [person, 0]));
  const paidByPerson = Object.fromEntries(project.participants.map((person) => [person, 0]));
  let subtotal = 0;
  let total = 0;

  const receiptSummaries = project.receipts.map((receipt) => {
    const calculations = calculateReceiptSplit({
      items: receipt.items,
      participants: project.participants,
      paidBy: receipt.paidBy,
      taxTip: receipt.taxTip,
    });

    project.participants.forEach((person) => {
      owedByPerson[person] += calculations.owedByPerson[person] || 0;
      paidByPerson[person] += calculations.paidByPerson[person] || 0;
    });

    subtotal += calculations.subtotal;
    total += calculations.total;

    return { receipt, calculations };
  });

  const netByPerson = Object.fromEntries(
    project.participants.map((person) => [person, (paidByPerson[person] || 0) - (owedByPerson[person] || 0)]),
  );

  return {
    subtotal,
    total,
    owedByPerson,
    paidByPerson,
    netByPerson,
    settlements: simplifyDebts(netByPerson),
    receiptSummaries,
  };
}

export default function ReceiptSplitApp() {
  const fileInputRef = useRef(null);
  const applyingRemoteProjectRef = useRef(false);
  const autoSyncTimerRef = useRef(null);
  const savingProjectRef = useRef(false);
  const urlProjectId = getProjectIdFromUrl();
  const [project, setProject] = useState(loadInitialProject);
  const [activeReceiptId, setActiveReceiptId] = useState(project.receipts[0]?.id);
  const [newPerson, setNewPerson] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [shareStatus, setShareStatus] = useState(urlProjectId ? "Loading shared project..." : "");
  const [isSharedProject, setIsSharedProject] = useState(Boolean(urlProjectId));
  const [sharedProjectLoaded, setSharedProjectLoaded] = useState(!urlProjectId);

  const activeReceipt = project.receipts.find((receipt) => receipt.id === activeReceiptId) || project.receipts[0];

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(project));
  }, [project]);

  useEffect(() => {
    const id = getProjectIdFromUrl();
    if (!id || !hasSupabaseConfig || !supabase) return;

    let cancelled = false;

    loadProjectFromSupabase(id)
      .then((loadedProject) => {
        if (cancelled) return;
        applyingRemoteProjectRef.current = true;
        setProject(loadedProject);
        setActiveReceiptId(loadedProject.receipts[0]?.id);
        setIsSharedProject(true);
        setSharedProjectLoaded(true);
        setShareStatus("Shared project loaded.");
      })
      .catch((error) => {
        if (!cancelled) {
          setSharedProjectLoaded(false);
          setShareStatus(`Could not load shared project: ${error.message}`);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const id = getProjectIdFromUrl();
    if (!id || !hasSupabaseConfig || !supabase) return undefined;

    let reloadTimer;
    const reloadProject = () => {
      window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(async () => {
        try {
          const loadedProject = await loadProjectFromSupabase(id);
          applyingRemoteProjectRef.current = true;
          setProject(loadedProject);
          setActiveReceiptId((currentId) =>
            loadedProject.receipts.some((receipt) => receipt.id === currentId) ? currentId : loadedProject.receipts[0]?.id,
          );
          setSharedProjectLoaded(true);
          setShareStatus("Shared project refreshed.");
        } catch (error) {
          setShareStatus(`Realtime refresh failed: ${error.message}`);
        }
      }, 500);
    };

    const channel = supabase
      .channel(`project-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "projects", filter: `id=eq.${id}` }, reloadProject)
      .on("postgres_changes", { event: "*", schema: "public", table: "project_members", filter: `project_id=eq.${id}` }, reloadProject)
      .on("postgres_changes", { event: "*", schema: "public", table: "receipts", filter: `project_id=eq.${id}` }, reloadProject)
      .on("postgres_changes", { event: "*", schema: "public", table: "receipt_items" }, reloadProject)
      .subscribe();

    return () => {
      window.clearTimeout(reloadTimer);
      supabase.removeChannel(channel);
    };
  }, [isSharedProject, project.id]);

  useEffect(() => {
    if (!isSharedProject || !sharedProjectLoaded || !hasSupabaseConfig || !supabase) return undefined;

    if (applyingRemoteProjectRef.current) {
      applyingRemoteProjectRef.current = false;
      return undefined;
    }

    window.clearTimeout(autoSyncTimerRef.current);
    autoSyncTimerRef.current = window.setTimeout(async () => {
      if (savingProjectRef.current) return;

      savingProjectRef.current = true;
      setShareStatus("Auto-syncing shared project...");

      try {
        const savedProject = await saveProjectToSupabase(project);
        if (savedProject.id !== project.id) {
          applyingRemoteProjectRef.current = true;
          setProject(savedProject);
          setProjectIdInUrl(savedProject.id);
        }
        setShareStatus("Shared project auto-synced.");
      } catch (error) {
        setShareStatus(`Auto-sync failed: ${error.message}`);
      } finally {
        savingProjectRef.current = false;
      }
    }, 1200);

    return () => {
      window.clearTimeout(autoSyncTimerRef.current);
    };
  }, [isSharedProject, project, sharedProjectLoaded]);

  const updateProject = (patch) => {
    setProject((current) => ({ ...current, ...patch }));
  };

  const updateActiveReceipt = (patch) => {
    setProject((current) => ({
      ...current,
      receipts: current.receipts.map((receipt) => (receipt.id === activeReceipt.id ? { ...receipt, ...patch } : receipt)),
    }));
  };

  const updateActiveItems = (updater) => {
    updateActiveReceipt({ items: typeof updater === "function" ? updater(activeReceipt.items) : updater });
  };

  const addParticipant = () => {
    const clean = newPerson.trim();
    if (!clean || project.participants.includes(clean)) return;

    setProject((current) => ({
      ...current,
      participants: [...current.participants, clean],
      receipts: current.receipts.map((receipt) => ({
        ...receipt,
        items: receipt.items.map((item) => ({ ...item, sharedBy: [...item.sharedBy, clean] })),
      })),
    }));
    setNewPerson("");
  };

  const removeParticipant = (name) => {
    setProject((current) => {
      const participants = current.participants.filter((person) => person !== name);
      const fallbackPayer = participants[0] || "";
      return {
        ...current,
        participants,
        receipts: current.receipts.map((receipt) => ({
          ...receipt,
          paidBy: receipt.paidBy === name ? fallbackPayer : receipt.paidBy,
          items: receipt.items.map((item) => ({ ...item, sharedBy: item.sharedBy.filter((person) => person !== name) })),
        })),
      };
    });
  };

  const addReceipt = (receiptType = "restaurant") => {
    const receipt = createReceipt({
      place: receiptType === "rideshare" ? "New ride share" : "New place",
      receiptType,
      paidBy: project.participants[0] || "",
      items: [
        {
          id: crypto.randomUUID(),
          name: receiptType === "rideshare" ? "Ride share" : "New item",
          category: receiptType === "rideshare" ? "Ride share" : "Shared",
          amount: 0,
          sharedBy: [...project.participants],
        },
      ],
      taxTip: receiptType === "rideshare" ? 0 : 18,
    });

    setProject((current) => ({ ...current, receipts: [...current.receipts, receipt] }));
    setActiveReceiptId(receipt.id);
  };

  const removeReceipt = (receiptId) => {
    if (project.receipts.length === 1) return;
    const remainingReceipts = project.receipts.filter((receipt) => receipt.id !== receiptId);
    if (receiptId === activeReceipt.id) {
      setActiveReceiptId(remainingReceipts[0]?.id);
    }
    setProject((current) => ({
      ...current,
      receipts: current.receipts.filter((receipt) => receipt.id !== receiptId),
    }));
  };

  const addItem = () => {
    updateActiveItems((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        name: activeReceipt.receiptType === "rideshare" ? "Ride share" : "New item",
        category: activeReceipt.receiptType === "rideshare" ? "Ride share" : "Shared",
        amount: 0,
        sharedBy: [...project.participants],
      },
    ]);
  };

  const updateItem = (id, patch) => {
    updateActiveItems((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const toggleShare = (itemId, person) => {
    updateActiveItems((items) =>
      items.map((item) => {
        if (item.id !== itemId) return item;
        const exists = item.sharedBy.includes(person);
        return {
          ...item,
          sharedBy: exists ? item.sharedBy.filter((sharedPerson) => sharedPerson !== person) : [...item.sharedBy, person],
        };
      }),
    );
  };

  const activeCalculations = useMemo(
    () =>
      calculateReceiptSplit({
        items: activeReceipt.items,
        participants: project.participants,
        paidBy: activeReceipt.paidBy,
        taxTip: activeReceipt.taxTip,
      }),
    [activeReceipt.items, activeReceipt.paidBy, activeReceipt.taxTip, project.participants],
  );

  const projectCalculations = useMemo(() => calculateProjectSplit(project), [project]);

  const convertedSettlements = projectCalculations.settlements.map((settlement) => ({
    ...settlement,
    convertedAmount: settlement.amount * Number(project.exchangeRate || 1),
  }));

  const applyParsedReceipt = (parsedReceipt, sourceLabel) => {
    const parsedItems = parsedReceipt.items.map((item) => ({
      id: crypto.randomUUID(),
      name: item.name,
      category: item.category,
      amount: item.amount,
      sharedBy: [...project.participants],
    }));

    if (!parsedItems.length) {
      throw new Error(`${sourceLabel} did not find itemized receipt rows.`);
    }

    updateActiveReceipt({
      items: parsedItems,
      merchant: parsedReceipt.merchant,
      place: parsedReceipt.merchant || activeReceipt.place,
      baseCurrency: currencySymbols[parsedReceipt.currency] ? parsedReceipt.currency : "USD",
      taxTip:
        parsedReceipt.subtotal > 0
          ? Number((((parsedReceipt.tax + parsedReceipt.tip) / parsedReceipt.subtotal) * 100).toFixed(2))
          : 0,
      ocrStatus: `${sourceLabel} itemized ${parsedItems.length} receipt item${parsedItems.length === 1 ? "" : "s"}.`,
    });
  };

  const handleReceiptUpload = async (event) => {
    const [file] = event.target.files || [];
    if (!file) return;

    updateActiveReceipt({ ocrText: "", merchant: "", ocrStatus: "Running local Tesseract OCR..." });

    try {
      const text = await extractReceiptText(file, (progress) => {
        updateActiveReceipt({ ocrStatus: `Running local Tesseract OCR: ${progress}%` });
      });

      updateActiveReceipt({ ocrText: text });

      if (text.trim().length >= 40) {
        updateActiveReceipt({ ocrStatus: "Parsing Tesseract text with Gemini..." });
        try {
          const parsedReceipt = await parseReceiptTextWithGemini(text);
          applyParsedReceipt(parsedReceipt, "Tesseract text + Gemini");
          return;
        } catch (textParseError) {
          updateActiveReceipt({
            ocrStatus: `Text parse failed: ${textParseError.message}. Trying Gemini image parsing...`,
          });
        }
      } else {
        updateActiveReceipt({ ocrStatus: "OCR text was too short. Trying Gemini image parsing..." });
      }

      const parsedReceipt = await parseReceiptImageWithGemini(file);
      applyParsedReceipt(parsedReceipt, "Gemini image");
    } catch (error) {
      updateActiveReceipt({ ocrStatus: `Receipt parsing failed: ${error.message}` });
    } finally {
      event.target.value = "";
    }
  };

  const saveProject = async () => {
    setSaveStatus("");

    if (!hasSupabaseConfig || !supabase) {
      setSaveStatus("Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel or .env to enable Supabase saving.");
      return;
    }

    try {
      savingProjectRef.current = true;
      const savedProject = await saveProjectToSupabase(project);
      applyingRemoteProjectRef.current = true;
      setProject(savedProject);
      setProjectIdInUrl(savedProject.id);
      setIsSharedProject(true);
      setSharedProjectLoaded(true);
      setShareStatus("Share link is active. Others can open this URL and add receipts.");
      setSaveStatus("Project synced to Supabase.");
    } catch (error) {
      setSaveStatus(`Save failed: ${error.message}`);
    } finally {
      savingProjectRef.current = false;
    }
  };

  const copyShareLink = async () => {
    if (!isSharedProject) {
      setShareStatus("Sync the project to Supabase first, then copy the shared link.");
      return;
    }

    await navigator.clipboard.writeText(window.location.href);
    setShareStatus("Shared project link copied.");
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 text-left text-slate-900 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 rounded-3xl bg-white p-6 shadow-sm xl:flex-row xl:items-center xl:justify-between">
          <div className="space-y-3">
            <p className="text-sm font-medium text-slate-500">Trip, event, and group expense splitter</p>
            <input
              className="w-full rounded-2xl border px-4 py-3 text-3xl font-bold tracking-tight xl:w-[32rem]"
              value={project.name}
              onChange={(event) => updateProject({ name: event.target.value })}
              aria-label="Project name"
            />
            <p className="max-w-2xl text-slate-600">
              Nest restaurants, ride shares, hotels, and one-off expenses under one trip or event, then settle the whole project.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3 xl:min-w-[31rem]">
            <div className="rounded-2xl bg-slate-100 p-4">
              <p className="text-sm text-slate-500">Receipts</p>
              <p className="text-2xl font-semibold">{project.receipts.length}</p>
            </div>
            <div className="rounded-2xl bg-slate-100 p-4">
              <p className="text-sm text-slate-500">Project total</p>
              <p className="text-2xl font-semibold">{money(projectCalculations.total, activeReceipt.baseCurrency)}</p>
            </div>
            <div className="rounded-2xl bg-slate-900 p-4 text-white">
              <p className="text-sm text-slate-300">Settle in</p>
              <p className="text-2xl font-semibold">{project.settlementCurrency}</p>
            </div>
          </div>
        </header>

        <section className="flex flex-col gap-3 rounded-3xl bg-white p-5 shadow-sm md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Shared project</h2>
            <p className="text-sm text-slate-500">
              Sync to Supabase to keep this trip across devices and let others add receipts from the same link.
            </p>
            {shareStatus ? <p className="mt-2 text-sm text-slate-700">{shareStatus}</p> : null}
            {isSharedProject && !sharedProjectLoaded ? (
              <p className="mt-2 text-sm font-medium text-amber-700">
                This shared link has not loaded from Supabase yet, so edits here may only be local.
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={saveProject}
              className="rounded-2xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700"
            >
              Sync shared project
            </button>
            <button
              type="button"
              onClick={copyShareLink}
              className="rounded-2xl border px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
            >
              Copy link
            </button>
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
          <section className="space-y-6">
            <div className="rounded-3xl bg-white shadow-sm">
              <div className="space-y-4 p-5">
                <div className="flex items-center gap-2">
                  <SectionIcon>TR</SectionIcon>
                  <h2 className="text-xl font-semibold">Receipts and expenses</h2>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => addReceipt("restaurant")}
                    className="rounded-2xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700"
                  >
                    New place
                  </button>
                  <button
                    type="button"
                    onClick={() => addReceipt("rideshare")}
                    className="rounded-2xl border px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
                  >
                    New ride
                  </button>
                </div>
                <div className="space-y-2">
                  {project.receipts.map((receipt) => {
                    const summary = projectCalculations.receiptSummaries.find((entry) => entry.receipt.id === receipt.id);
                    return (
                      <button
                        type="button"
                        key={receipt.id}
                        onClick={() => setActiveReceiptId(receipt.id)}
                        className={`w-full rounded-2xl border p-3 text-left ${
                          receipt.id === activeReceipt.id ? "border-slate-900 bg-slate-100" : "bg-white hover:bg-slate-50"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-semibold">{receipt.place || "Untitled expense"}</p>
                            <p className="text-sm text-slate-500">
                              {receipt.receiptType} · paid by {receipt.paidBy || "Unassigned"}
                            </p>
                          </div>
                          <span className="font-semibold">{money(summary?.calculations.total || 0, receipt.baseCurrency)}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

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
                  {project.participants.map((person) => (
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
                  <h2 className="text-xl font-semibold">Project currency</h2>
                </div>
                <label className="text-sm">
                  Settle project in
                  <select
                    className="mt-1 w-full rounded-2xl border px-3 py-2"
                    value={project.settlementCurrency}
                    onChange={(event) => updateProject({ settlementCurrency: event.target.value })}
                  >
                    {Object.keys(currencySymbols).map((currency) => (
                      <option key={currency}>{currency}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  Exchange rate from receipt currency
                  <input
                    type="number"
                    step="0.0001"
                    className="mt-1 w-full rounded-2xl border px-3 py-2"
                    value={project.exchangeRate}
                    onChange={(event) => updateProject({ exchangeRate: event.target.value })}
                  />
                </label>
              </div>
            </div>
          </section>

          <main className="space-y-6">
            <div className="rounded-3xl bg-white shadow-sm">
              <div className="space-y-5 p-5">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex items-center gap-2">
                    <SectionIcon>{activeReceipt.receiptType === "rideshare" ? "RS" : "RC"}</SectionIcon>
                    <h2 className="text-xl font-semibold">Active receipt</h2>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="rounded-2xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700"
                    >
                      Upload receipt
                    </button>
                    <button
                      type="button"
                      onClick={() => removeReceipt(activeReceipt.id)}
                      disabled={project.receipts.length === 1}
                      className="rounded-2xl border px-4 py-2 font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Delete receipt
                    </button>
                    <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleReceiptUpload} />
                  </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-4">
                  <label className="text-sm lg:col-span-2">
                    Place or merchant
                    <input
                      className="mt-1 w-full rounded-2xl border px-3 py-2"
                      value={activeReceipt.place}
                      onChange={(event) => updateActiveReceipt({ place: event.target.value })}
                    />
                  </label>
                  <label className="text-sm">
                    Type
                    <select
                      className="mt-1 w-full rounded-2xl border px-3 py-2"
                      value={activeReceipt.receiptType}
                      onChange={(event) => updateActiveReceipt({ receiptType: event.target.value })}
                    >
                      <option value="restaurant">Restaurant</option>
                      <option value="groceries">Groceries</option>
                      <option value="rideshare">Ride share</option>
                      <option value="hotel">Hotel / lodging</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <label className="text-sm">
                    Paid by
                    <select
                      className="mt-1 w-full rounded-2xl border px-3 py-2"
                      value={activeReceipt.paidBy}
                      onChange={(event) => updateActiveReceipt({ paidBy: event.target.value })}
                    >
                      {project.participants.map((person) => (
                        <option key={person}>{person}</option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="rounded-2xl border bg-slate-50 p-3">
                  <p className="text-sm font-medium text-slate-600">Tesseract OCR + Gemini parser</p>
                  <p className="text-sm text-slate-500">{activeReceipt.ocrStatus}</p>
                  {activeReceipt.merchant ? (
                    <p className="mt-2 text-sm font-medium text-slate-700">Parsed merchant: {activeReceipt.merchant}</p>
                  ) : null}
                  {activeReceipt.ocrText ? (
                    <pre className="mt-3 max-h-36 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-3 text-xs text-slate-600">
                      {activeReceipt.ocrText}
                    </pre>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-2">
                    <select
                      className="rounded-2xl border px-3 py-2"
                      value={activeReceipt.baseCurrency}
                      onChange={(event) => updateActiveReceipt({ baseCurrency: event.target.value })}
                    >
                      {Object.keys(currencySymbols).map((currency) => (
                        <option key={currency}>{currency}</option>
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
                      {activeReceipt.items.map((item) => (
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
                              {project.participants.map((person) => (
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
                              onClick={() => updateActiveItems((items) => items.filter((currentItem) => currentItem.id !== item.id))}
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
                      value={activeReceipt.taxTip}
                      onChange={(event) => updateActiveReceipt({ taxTip: event.target.value })}
                    />
                  </label>
                  <div className="rounded-2xl bg-slate-100 p-4">
                    <p className="text-sm text-slate-500">Receipt subtotal</p>
                    <p className="text-2xl font-semibold">{money(activeCalculations.subtotal, activeReceipt.baseCurrency)}</p>
                  </div>
                  <div className="rounded-2xl bg-slate-900 p-4 text-white">
                    <p className="text-sm text-slate-300">Receipt total</p>
                    <p className="text-2xl font-semibold">{money(activeCalculations.total, activeReceipt.baseCurrency)}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-3xl bg-white shadow-sm">
                <div className="space-y-4 p-5">
                  <div className="flex items-center gap-2">
                    <SectionIcon>TO</SectionIcon>
                    <h2 className="text-xl font-semibold">Project shares</h2>
                  </div>
                  {project.participants.map((person) => (
                    <div key={person} className="flex items-center justify-between rounded-2xl bg-slate-100 px-4 py-3">
                      <span>{person}</span>
                      <span className="font-semibold">{money(projectCalculations.owedByPerson[person], activeReceipt.baseCurrency)}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-3xl bg-white shadow-sm">
                <div className="space-y-4 p-5">
                  <h2 className="text-xl font-semibold">Project settlement</h2>
                  {convertedSettlements.length === 0 ? (
                    <div className="rounded-2xl bg-green-50 p-4 text-green-700">Everyone is settled.</div>
                  ) : (
                    convertedSettlements.map((settlement) => (
                      <div key={`${settlement.from}-${settlement.to}`} className="rounded-2xl border bg-white p-4">
                        <p className="font-medium">
                          {settlement.from} pays {settlement.to}
                        </p>
                        <p className="text-2xl font-bold">{money(settlement.convertedAmount, project.settlementCurrency)}</p>
                        <p className="text-sm text-slate-500">Original: {money(settlement.amount, activeReceipt.baseCurrency)}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-3xl bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-xl font-semibold">Store project</h2>
                  <p className="text-sm text-slate-500">
                    Auto-saves in this browser. Sync to Supabase to share across devices and collaborators.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={saveProject}
                  className="rounded-2xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700"
                >
                  Sync shared project
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
