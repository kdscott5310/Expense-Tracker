import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyRecordedSettlementPayments,
  calculatePayerReimbursements,
  calculateReceiptSplit,
  currencySymbols,
  groupSettlementEntries,
  mapSettlementParty,
  money,
} from "./lib/calculations";
import { extractReceiptText } from "./lib/ocr";
import {
  clearProjectIdInUrl,
  createTripCode,
  findProjectIdByName,
  findProjectIdByTripCode,
  getProjectIdFromUrl,
  listUserProjects,
  loadProjectFromSupabase,
  normalizeTripCode,
  saveProjectToSupabase,
  setProjectIdInUrl,
} from "./lib/projectStore";
import { parseReceiptImageWithGemini, parseReceiptTextWithGemini } from "./lib/receiptParser";
import { hasSupabaseConfig, supabase } from "./lib/supabaseClient";

const storageKey = "receipt-split-project-v1";
const defaultParticipants = ["Kevin", "Alex", "Jamie", "Taylor"];
const defaultSettlementGroups = [
  { id: "kevin-simone", name: "Kevin + Simone", members: ["Kevin", "Simone"] },
  { id: "tyler-lindsay", name: "Tyler + Lindsay", members: ["Tyler", "Lindsay"] },
];

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
    expenseDate: overrides.expenseDate || "",
    tripStop: overrides.tripStop || "",
    activity: overrides.activity || "",
    payments: overrides.payments || [],
    baseCurrency: overrides.baseCurrency || "EUR",
    taxTip: overrides.taxTip ?? 18,
    items: overrides.items || sampleItems.map((item) => ({ ...item, id: crypto.randomUUID(), sharedBy: [...item.sharedBy] })),
    ocrText: overrides.ocrText || "",
    ocrStatus: overrides.ocrStatus || "Ready for receipt image upload.",
  };
}

function expenseTypeLabel(type) {
  const labels = {
    restaurant: "Restaurant",
    groceries: "Groceries",
    rideshare: "Ride share",
    hotel: "Hotel / lodging",
    other: "Other",
  };

  return labels[type] || "Expense";
}

function createInitialProject() {
  return {
    id: crypto.randomUUID(),
    name: "Barcelona trip",
    tripCode: "",
    participants: defaultParticipants,
    settlementGroups: [],
    settlementPayments: [],
    settlementCurrency: "USD",
    exchangeRate: 1.08,
    receipts: [createReceipt()],
  };
}

function fallbackSettlementGroups(participants = []) {
  return defaultSettlementGroups.filter((group) => group.members.every((member) => participants.includes(member)));
}

function normalizeSettlementGroups(project) {
  const hasSavedGroups = Array.isArray(project.settlementGroups);
  const savedGroups = hasSavedGroups ? project.settlementGroups : [];
  const groups = hasSavedGroups ? savedGroups : fallbackSettlementGroups(project.participants);

  return groups
    .map((group) => ({
      id: group.id || crypto.randomUUID(),
      name: group.name || "Settlement group",
      members: [...new Set((group.members || []).filter((member) => project.participants.includes(member)))],
    }))
    .filter((group) => group.members.length > 0);
}

function normalizeProject(project) {
  return {
    ...project,
    settlementGroups: normalizeSettlementGroups(project),
    settlementPayments: Array.isArray(project.settlementPayments) ? project.settlementPayments : [],
  };
}

function loadInitialProject() {
  if (typeof window === "undefined") return createInitialProject();

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return createInitialProject();
    const parsed = JSON.parse(stored);
    if (!parsed.receipts?.length) return createInitialProject();
    return normalizeProject(parsed);
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

function formatServerTime(value) {
  if (!value) return "Not synced yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not synced yet";
  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function getActiveSettlementGroups(project) {
  return normalizeSettlementGroups(project).filter((group) => group.members.length > 1);
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
      payments: receipt.payments,
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
    settlements: calculatePayerReimbursements(receiptSummaries, project.participants),
    receiptSummaries,
  };
}

function buildParticipantAudit(project, projectCalculations, person) {
  const receiptAudits = projectCalculations.receiptSummaries
    .map(({ receipt, calculations }) => {
      const multiplier = 1 + Number(receipt.taxTip || 0) / 100;
      const itemCharges = receipt.items
        .map((item) => {
          const sharedBy = item.sharedBy.length ? item.sharedBy : project.participants;
          if (!sharedBy.includes(person)) return null;

          return {
            id: item.id,
            name: item.name,
            category: item.category,
            sharedCount: sharedBy.length,
            amount: (Number(item.amount || 0) * multiplier) / sharedBy.length,
          };
        })
        .filter(Boolean);
      const owed = calculations.owedByPerson[person] || 0;
      const paid = calculations.paidByPerson[person] || 0;

      if (owed <= 0.01 && paid <= 0.01 && itemCharges.length === 0) return null;

      return {
        receipt,
        owed,
        paid,
        net: paid - owed,
        itemCharges,
      };
    })
    .filter(Boolean);

  return {
    person,
    owed: projectCalculations.owedByPerson[person] || 0,
    paid: projectCalculations.paidByPerson[person] || 0,
    net: projectCalculations.netByPerson[person] || 0,
    receiptAudits,
    sentPayments: (project.settlementPayments || []).filter((payment) => payment.from === person),
    receivedPayments: (project.settlementPayments || []).filter((payment) => payment.to === person),
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
  const [parserMode, setParserMode] = useState("ai-image");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authStatus, setAuthStatus] = useState("");
  const [currentUser, setCurrentUser] = useState(null);
  const [userProjects, setUserProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [tripListStatus, setTripListStatus] = useState("");
  const [accessTripCode, setAccessTripCode] = useState(project.tripCode || "");
  const [tripAccessStatus, setTripAccessStatus] = useState("");
  const [settlementMode, setSettlementMode] = useState("groups");
  const [newSettlementGroupName, setNewSettlementGroupName] = useState("");
  const [auditPerson, setAuditPerson] = useState(project.participants[0] || "");

  const activeReceipt = project.receipts.find((receipt) => receipt.id === activeReceiptId) || project.receipts[0];
  const serverSyncLabel = formatServerTime(project.serverSyncedAt);

  const applyLoadedProject = useCallback((loadedProject, status = "Shared project loaded.") => {
    applyingRemoteProjectRef.current = true;
    const normalizedProject = normalizeProject(loadedProject);
    setProject(normalizedProject);
    setActiveReceiptId(loadedProject.receipts[0]?.id);
    setSelectedProjectId(normalizedProject.id);
    setAccessTripCode(normalizedProject.tripCode || "");
    setProjectIdInUrl(normalizedProject.id);
    setIsSharedProject(true);
    setSharedProjectLoaded(true);
    setShareStatus(status);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(project));
  }, [project]);

  const refreshUserProjects = useCallback(
    async (userId = currentUser?.id) => {
      if (!userId || !hasSupabaseConfig || !supabase) {
        setUserProjects([]);
        setSelectedProjectId("");
        return;
      }

      try {
        const projects = await listUserProjects(userId);
        setUserProjects(projects);
        setSelectedProjectId((currentId) =>
          projects.some((savedProject) => savedProject.id === currentId) ? currentId : projects[0]?.id || "",
        );
        setTripListStatus(projects.length ? "Saved trips loaded." : "No saved trips yet.");
      } catch (error) {
        setTripListStatus(`Could not load trips: ${error.message}`);
      }
    },
    [currentUser?.id],
  );

  useEffect(() => {
    if (!hasSupabaseConfig || !supabase) return undefined;

    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setCurrentUser(data.session?.user || null);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setCurrentUser(session?.user || null);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    Promise.resolve().then(() => refreshUserProjects(currentUser?.id));
  }, [currentUser?.id, refreshUserProjects]);

  useEffect(() => {
    const id = getProjectIdFromUrl();
    if (!id || !hasSupabaseConfig || !supabase) return;

    let cancelled = false;

    loadProjectFromSupabase(id)
      .then((loadedProject) => {
        if (cancelled) return;
        applyLoadedProject(loadedProject);
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
  }, [applyLoadedProject]);

  useEffect(() => {
    const id = getProjectIdFromUrl();
    if (!id || !hasSupabaseConfig || !supabase) return undefined;

    let reloadTimer;
    const reloadProject = () => {
      window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(async () => {
        try {
          const loadedProject = await loadProjectFromSupabase(id);
          const normalizedProject = normalizeProject(loadedProject);
          applyingRemoteProjectRef.current = true;
          setProject(normalizedProject);
          setActiveReceiptId((currentId) =>
            normalizedProject.receipts.some((receipt) => receipt.id === currentId) ? currentId : normalizedProject.receipts[0]?.id,
          );
          setSharedProjectLoaded(true);
          setShareStatus(`Pulled latest server sync: ${formatServerTime(loadedProject.serverSyncedAt)}.`);
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
        const savedProject = await saveProjectToSupabase(project, { userId: currentUser?.id });
        const normalizedProject = normalizeProject(savedProject);
        applyingRemoteProjectRef.current = true;
        setProject(normalizedProject);
        if (normalizedProject.id !== project.id) {
          setProjectIdInUrl(normalizedProject.id);
        }
        setShareStatus(`Auto-synced to server: ${formatServerTime(normalizedProject.serverSyncedAt)}.`);
      } catch (error) {
        setShareStatus(`Auto-sync failed: ${error.message}`);
      } finally {
        savingProjectRef.current = false;
      }
    }, 1200);

    return () => {
      window.clearTimeout(autoSyncTimerRef.current);
    };
  }, [currentUser?.id, isSharedProject, project, sharedProjectLoaded]);

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
        settlementGroups: (current.settlementGroups || [])
          .map((group) => ({ ...group, members: group.members.filter((member) => member !== name) }))
          .filter((group) => group.members.length > 0),
        settlementPayments: (current.settlementPayments || []).filter((payment) => payment.from !== name && payment.to !== name),
        receipts: current.receipts.map((receipt) => ({
          ...receipt,
          paidBy: receipt.paidBy === name ? fallbackPayer : receipt.paidBy,
          payments: (receipt.payments || []).filter((payment) => payment.person !== name),
          items: receipt.items.map((item) => ({ ...item, sharedBy: item.sharedBy.filter((person) => person !== name) })),
        })),
      };
    });
  };

  const addSettlementGroup = () => {
    const cleanName = newSettlementGroupName.trim() || `Group ${(project.settlementGroups || []).length + 1}`;
    setProject((current) => ({
      ...current,
      settlementGroups: [
        ...(current.settlementGroups || []),
        {
          id: crypto.randomUUID(),
          name: cleanName,
          members: [],
        },
      ],
    }));
    setNewSettlementGroupName("");
    setSettlementMode("groups");
  };

  const updateSettlementGroup = (groupId, patch) => {
    setProject((current) => ({
      ...current,
      settlementGroups: (current.settlementGroups || []).map((group) => (group.id === groupId ? { ...group, ...patch } : group)),
    }));
    setSettlementMode("groups");
  };

  const removeSettlementGroup = (groupId) => {
    setProject((current) => ({
      ...current,
      settlementGroups: (current.settlementGroups || []).filter((group) => group.id !== groupId),
    }));
    setSettlementMode("groups");
  };

  const toggleSettlementGroupMember = (groupId, person) => {
    setProject((current) => ({
      ...current,
      settlementGroups: (current.settlementGroups || []).map((group) => {
        if (group.id !== groupId) return { ...group, members: group.members.filter((member) => member !== person) };
        const hasMember = group.members.includes(person);
        return {
          ...group,
          members: hasMember ? group.members.filter((member) => member !== person) : [...group.members, person],
        };
      }),
    }));
    setSettlementMode("groups");
  };

  const addSettlementPayment = () => {
    setProject((current) => ({
      ...current,
      settlementPayments: [
        ...(current.settlementPayments || []),
        {
          id: crypto.randomUUID(),
          from: current.participants[0] || "",
          to: current.participants.find((name) => name !== current.participants[0]) || "",
          amount: "",
          note: "",
        },
      ],
    }));
  };

  const updateSettlementPayment = (paymentId, patch) => {
    setProject((current) => ({
      ...current,
      settlementPayments: (current.settlementPayments || []).map((payment) =>
        payment.id === paymentId ? { ...payment, ...patch } : payment,
      ),
    }));
  };

  const removeSettlementPayment = (paymentId) => {
    setProject((current) => ({
      ...current,
      settlementPayments: (current.settlementPayments || []).filter((payment) => payment.id !== paymentId),
    }));
  };

  const addReceipt = (receiptType = "restaurant") => {
    const receipt = createReceipt({
      place: "New expense",
      receiptType,
      paidBy: project.participants[0] || "",
      payments: [],
      items: [
        {
          id: crypto.randomUUID(),
          name: "New item",
          category: expenseTypeLabel(receiptType),
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
        category: expenseTypeLabel(activeReceipt.receiptType),
        amount: 0,
        sharedBy: [...project.participants],
      },
    ]);
  };

  const updateItem = (id, patch) => {
    updateActiveItems((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const addPayment = () => {
    updateActiveReceipt({
      payments: [
        ...(activeReceipt.payments || []),
        {
          id: crypto.randomUUID(),
          person: activeReceipt.paidBy || project.participants[0] || "",
          amount: "",
        },
      ],
    });
  };

  const updatePayment = (id, patch) => {
    updateActiveReceipt({
      payments: (activeReceipt.payments || []).map((payment) => (payment.id === id ? { ...payment, ...patch } : payment)),
    });
  };

  const removePayment = (id) => {
    updateActiveReceipt({
      payments: (activeReceipt.payments || []).filter((payment) => payment.id !== id),
    });
  };

  const duplicateActiveExpense = () => {
    const receipt = createReceipt({
      ...activeReceipt,
      id: crypto.randomUUID(),
      place: `${activeReceipt.place || "Expense"} copy`,
      items: activeReceipt.items.map((item) => ({ ...item, id: crypto.randomUUID(), sharedBy: [...item.sharedBy] })),
      payments: (activeReceipt.payments || []).map((payment) => ({ ...payment, id: crypto.randomUUID() })),
      ocrStatus: "Duplicated from another expense.",
    });

    setProject((current) => ({ ...current, receipts: [...current.receipts, receipt] }));
    setActiveReceiptId(receipt.id);
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
        payments: activeReceipt.payments,
      }),
    [activeReceipt.items, activeReceipt.paidBy, activeReceipt.payments, activeReceipt.taxTip, project.participants],
  );

  const projectCalculations = useMemo(() => calculateProjectSplit(project), [project]);
  const activeAuditPerson = project.participants.includes(auditPerson) ? auditPerson : project.participants[0] || "";
  const participantAudit = useMemo(
    () => buildParticipantAudit(project, projectCalculations, activeAuditPerson),
    [activeAuditPerson, project, projectCalculations],
  );

  const activeSettlementGroups = useMemo(() => getActiveSettlementGroups(project), [project]);
  const effectiveSettlementMode = settlementMode === "groups" && activeSettlementGroups.length > 0 ? "groups" : "individual";
  const displayedSettlements =
    effectiveSettlementMode === "groups"
      ? groupSettlementEntries(projectCalculations.settlements, activeSettlementGroups)
      : projectCalculations.settlements;
  const settlementExchangeRate = Number(project.exchangeRate || 1) || 1;
  const convertedRawSettlements = displayedSettlements.map((settlement) => ({
    from: settlement.from,
    to: settlement.to,
    amount: settlement.amount * settlementExchangeRate,
  }));
  const activeSettlementPayments = (project.settlementPayments || [])
    .filter((payment) => project.participants.includes(payment.from) && project.participants.includes(payment.to))
    .map((payment) => ({
      ...payment,
      from: effectiveSettlementMode === "groups" ? mapSettlementParty(payment.from, activeSettlementGroups) : payment.from,
      to: effectiveSettlementMode === "groups" ? mapSettlementParty(payment.to, activeSettlementGroups) : payment.to,
    }));
  const convertedSettlements = applyRecordedSettlementPayments(convertedRawSettlements, activeSettlementPayments).map((settlement) => ({
    ...settlement,
    convertedAmount: settlement.amount,
    amount: settlement.amount / settlementExchangeRate,
  }));
  const recordedPaymentTotal = activeSettlementPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const activePaymentTotal = (activeReceipt.payments || []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const activePaymentDifference = activePaymentTotal - activeCalculations.total;
  const projectNetTotal = project.participants.reduce((sum, person) => sum + (projectCalculations.netByPerson[person] || 0), 0);

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

    updateActiveReceipt({ ocrText: "", merchant: "", ocrStatus: "Preparing receipt parser..." });

    try {
      if (parserMode === "ai-image" || file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        updateActiveReceipt({ ocrStatus: "Parsing receipt file directly with Gemini..." });
        const parsedReceipt = await parseReceiptImageWithGemini(file);
        applyParsedReceipt(parsedReceipt, "Gemini file");
        return;
      }

      updateActiveReceipt({ ocrStatus: "Running local Tesseract OCR..." });
      const text = await extractReceiptText(file, (progress) => {
        updateActiveReceipt({ ocrStatus: `Running local Tesseract OCR: ${progress}%` });
      });

      updateActiveReceipt({ ocrText: text });

      if (parserMode === "ocr-only") {
        updateActiveReceipt({
          ocrStatus: text ? "Tesseract OCR complete. Review the text below." : "Tesseract did not detect receipt text.",
        });
        return;
      }

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

  const signIn = async () => {
    setAuthStatus("");

    if (!hasSupabaseConfig || !supabase) {
      setAuthStatus("Add Supabase environment variables before signing in.");
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({
      email: authEmail.trim(),
      password: authPassword,
    });

    setAuthStatus(error ? `Sign in failed: ${error.message}` : "Signed in.");
  };

  const createAccount = async () => {
    setAuthStatus("");

    if (!hasSupabaseConfig || !supabase) {
      setAuthStatus("Add Supabase environment variables before creating an account.");
      return;
    }

    const { error } = await supabase.auth.signUp({
      email: authEmail.trim(),
      password: authPassword,
    });

    setAuthStatus(error ? `Account creation failed: ${error.message}` : "Account created. Check your email if confirmation is enabled.");
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    setCurrentUser(null);
    setUserProjects([]);
    setSelectedProjectId("");
    setAuthStatus("Signed out.");
  };

  const loadSelectedTrip = async () => {
    if (!selectedProjectId) {
      setTripListStatus("Choose a saved trip first.");
      return;
    }

    try {
      const loadedProject = await loadProjectFromSupabase(selectedProjectId);
      applyLoadedProject(loadedProject, "Loaded saved trip.");
      setTripListStatus("Saved trip loaded.");
    } catch (error) {
      setTripListStatus(`Could not load saved trip: ${error.message}`);
    }
  };

  const startNewTrip = () => {
    const tripCode = normalizeTripCode(accessTripCode) || createTripCode("New trip");
    const nextProject = {
      ...createInitialProject(),
      name: "New trip",
      tripCode,
    };
    applyingRemoteProjectRef.current = true;
    setProject(nextProject);
    setActiveReceiptId(nextProject.receipts[0]?.id);
    clearProjectIdInUrl();
    setIsSharedProject(false);
    setSharedProjectLoaded(true);
    setSelectedProjectId("");
    setAccessTripCode(tripCode);
    setTripAccessStatus(`Started ${tripCode}. Sync to save it for the group.`);
    setShareStatus("New local trip started. Sync to save it.");
    setSaveStatus("");
  };

  const loadTripByCode = async () => {
    setTripAccessStatus("");

    if (!hasSupabaseConfig || !supabase) {
      setTripAccessStatus("Add Supabase environment variables before loading a trip code.");
      return;
    }

    const cleanCode = normalizeTripCode(accessTripCode);
    if (!cleanCode) {
      setTripAccessStatus("Enter a trip code first.");
      return;
    }

    try {
      const projectId = await findProjectIdByTripCode(cleanCode);
      if (!projectId) {
        setTripAccessStatus(`No trip found for ${cleanCode}. Start a new trip with that code, then sync it.`);
        return;
      }

      const loadedProject = await loadProjectFromSupabase(projectId);
      applyLoadedProject(loadedProject, `Pulled latest server sync: ${formatServerTime(loadedProject.serverSyncedAt)}.`);
      setTripAccessStatus(`Loaded ${cleanCode}. Latest server sync: ${formatServerTime(loadedProject.serverSyncedAt)}.`);
    } catch (error) {
      setTripAccessStatus(`Trip code load failed: ${error.message}`);
    }
  };

  const pullLatestProject = async () => {
    setSaveStatus("");

    if (!hasSupabaseConfig || !supabase) {
      setShareStatus("Add Supabase environment variables before pulling the latest server copy.");
      return;
    }

    try {
      let projectId = isSharedProject ? project.id : "";
      const cleanCode = normalizeTripCode(accessTripCode || project.tripCode);
      if (!projectId && cleanCode) {
        projectId = await findProjectIdByTripCode(cleanCode);
      }

      if (!projectId) {
        setShareStatus("No shared project or trip code found to pull from Supabase.");
        return;
      }

      const loadedProject = await loadProjectFromSupabase(projectId);
      applyLoadedProject(loadedProject, `Pulled latest server sync: ${formatServerTime(loadedProject.serverSyncedAt)}.`);
      setTripAccessStatus(`Latest server sync: ${formatServerTime(loadedProject.serverSyncedAt)}.`);
    } catch (error) {
      setShareStatus(`Pull latest failed: ${error.message}`);
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

      const urlId = getProjectIdFromUrl();
      if ((urlId || isSharedProject) && !sharedProjectLoaded) {
        const idToLoad = urlId || project.id;
        const loadedProject = await loadProjectFromSupabase(idToLoad);
        applyLoadedProject(loadedProject, "Loaded the server project first. Review it, then sync after edits.");
        setSaveStatus("Loaded the existing shared project instead of saving local defaults.");
        return;
      }

      if (!isSharedProject && !currentUser) {
        const existingProjectId = await findProjectIdByName(project.name);
        if (existingProjectId && existingProjectId !== project.id) {
          const loadedProject = await loadProjectFromSupabase(existingProjectId);
          applyLoadedProject(loadedProject, "Loaded existing project by name.");
          setSaveStatus("Found this project name in Supabase and loaded it instead of creating a duplicate/default copy.");
          return;
        }
      }

      const cleanCode = normalizeTripCode(project.tripCode || accessTripCode);
      const projectToSave = cleanCode ? { ...project, tripCode: cleanCode } : project;
      const savedProject = await saveProjectToSupabase(projectToSave, { userId: currentUser?.id });
      const normalizedProject = normalizeProject(savedProject);
      applyingRemoteProjectRef.current = true;
      setProject(normalizedProject);
      setSelectedProjectId(normalizedProject.id);
      setAccessTripCode(normalizedProject.tripCode || "");
      setProjectIdInUrl(normalizedProject.id);
      setIsSharedProject(true);
      setSharedProjectLoaded(true);
      setShareStatus(`Synced to server: ${formatServerTime(normalizedProject.serverSyncedAt)}.`);
      setSaveStatus(
        normalizedProject.tripCode
          ? `Trip ${normalizedProject.tripCode} synced to Supabase at ${formatServerTime(normalizedProject.serverSyncedAt)}.`
          : `Project synced to Supabase at ${formatServerTime(normalizedProject.serverSyncedAt)}.`,
      );
      await refreshUserProjects(currentUser?.id);
    } catch (error) {
      setSaveStatus(`Save failed: ${error.message}`);
    } finally {
      savingProjectRef.current = false;
    }
  };

  const loadProjectByName = async () => {
    setSaveStatus("");

    if (!hasSupabaseConfig || !supabase) {
      setShareStatus("Add Supabase environment variables before loading a shared project.");
      return;
    }

    try {
      const existingProjectId = await findProjectIdByName(project.name);
      if (!existingProjectId) {
        setShareStatus(`No Supabase project found named "${project.name}". Sync once to create it.`);
        return;
      }

      const loadedProject = await loadProjectFromSupabase(existingProjectId);
      applyLoadedProject(loadedProject, "Loaded existing project by name.");
      setSaveStatus("Server project loaded with its saved people and receipts.");
    } catch (error) {
      setShareStatus(`Load by name failed: ${error.message}`);
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
              <p className="text-sm text-slate-500">Expenses</p>
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

        <section className="grid gap-4 rounded-3xl bg-white p-5 shadow-sm lg:grid-cols-[0.85fr_1.4fr]">
          <div>
            <h2 className="text-xl font-semibold">Trip code</h2>
            <p className="text-sm text-slate-500">Use one code for the group so everyone opens the same saved trip.</p>
            <p className="mt-2 text-sm font-medium text-slate-700">Latest server sync: {serverSyncLabel}</p>
            {tripAccessStatus ? <p className="mt-2 text-sm text-slate-700">{tripAccessStatus}</p> : null}
          </div>
          <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto_auto] lg:items-end">
            <label className="text-sm">
              Code
              <input
                className="mt-1 w-full rounded-2xl border px-3 py-2 font-mono uppercase"
                value={accessTripCode}
                onChange={(event) => {
                  const cleanCode = normalizeTripCode(event.target.value);
                  setAccessTripCode(cleanCode);
                  updateProject({ tripCode: cleanCode });
                }}
                placeholder="SPAIN-2026"
              />
            </label>
            <button
              type="button"
              onClick={loadTripByCode}
              className="rounded-2xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700"
            >
              Load trip
            </button>
            <button
              type="button"
              onClick={startNewTrip}
              className="rounded-2xl border px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
            >
              New trip
            </button>
            <button
              type="button"
              onClick={saveProject}
              className="rounded-2xl border px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
            >
              Sync
            </button>
            <button
              type="button"
              onClick={pullLatestProject}
              className="rounded-2xl border px-4 py-2 font-medium text-slate-700 hover:bg-slate-100 lg:col-start-2"
            >
              Pull latest
            </button>
          </div>
        </section>

        <details className="rounded-3xl bg-white p-5 shadow-sm">
          <summary className="cursor-pointer text-sm font-semibold text-slate-600">Advanced account login</summary>
          <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <h2 className="text-xl font-semibold">Account trips</h2>
            <p className="text-sm text-slate-500">Sign in to save trips to your account and load them from any device.</p>
            {authStatus ? <p className="mt-2 text-sm text-slate-700">{authStatus}</p> : null}
          </div>

          {currentUser ? (
            <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto_auto] lg:items-end">
              <label className="text-sm">
                Saved trip
                <select
                  className="mt-1 w-full rounded-2xl border px-3 py-2"
                  value={selectedProjectId}
                  onChange={(event) => setSelectedProjectId(event.target.value)}
                >
                  <option value="">Choose trip</option>
                  {userProjects.map((savedProject) => (
                    <option key={savedProject.id} value={savedProject.id}>
                      {savedProject.name} {savedProject.trip_code ? `(${savedProject.trip_code})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={loadSelectedTrip}
                className="rounded-2xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700"
              >
                Load trip
              </button>
              <button
                type="button"
                onClick={startNewTrip}
                className="rounded-2xl border px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
              >
                New trip
              </button>
              <button
                type="button"
                onClick={signOut}
                className="rounded-2xl border px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
              >
                Sign out
              </button>
              <p className="text-sm text-slate-500 lg:col-span-4">
                Signed in as {currentUser.email}. {tripListStatus}
              </p>
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-[1fr_1fr_auto_auto] lg:items-end">
              <label className="text-sm">
                Email
                <input
                  type="email"
                  className="mt-1 w-full rounded-2xl border px-3 py-2"
                  value={authEmail}
                  onChange={(event) => setAuthEmail(event.target.value)}
                />
              </label>
              <label className="text-sm">
                Password
                <input
                  type="password"
                  className="mt-1 w-full rounded-2xl border px-3 py-2"
                  value={authPassword}
                  onChange={(event) => setAuthPassword(event.target.value)}
                />
              </label>
              <button
                type="button"
                onClick={signIn}
                className="rounded-2xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700"
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={createAccount}
                className="rounded-2xl border px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
              >
                Create account
              </button>
            </div>
          )}
          </div>
        </details>

        <section className="flex flex-col gap-3 rounded-3xl bg-white p-5 shadow-sm md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Shared project</h2>
            <p className="text-sm text-slate-500">
              Sync to Supabase to keep this trip across devices and let others add receipts from the same link.
            </p>
            <p className="mt-2 text-sm font-medium text-slate-700">Latest server sync: {serverSyncLabel}</p>
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
              onClick={loadProjectByName}
              className="rounded-2xl border px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
            >
              Load by name
            </button>
            <button
              type="button"
              onClick={pullLatestProject}
              className="rounded-2xl border px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
            >
              Pull latest
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
                  <h2 className="text-xl font-semibold">Expenses</h2>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => addReceipt(activeReceipt?.receiptType || "restaurant")}
                    className="rounded-2xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700"
                  >
                    New Expense
                  </button>
                  <button
                    type="button"
                    onClick={() => removeReceipt(activeReceipt.id)}
                    disabled={project.receipts.length === 1}
                    className="rounded-2xl border px-4 py-2 font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Remove Expense
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
                              {expenseTypeLabel(receipt.receiptType)} | paid by {receipt.paidBy || "Unassigned"}
                            </p>
                            {receipt.expenseDate || receipt.tripStop ? (
                              <p className="text-xs text-slate-500">
                                {[receipt.expenseDate, receipt.tripStop].filter(Boolean).join(" | ")}
                              </p>
                            ) : null}
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
                <div className="border-t pt-4">
                  <div className="mb-3">
                    <h3 className="font-semibold">Settlement groups</h3>
                    <p className="text-sm text-slate-500">Group couples, families, or anyone settling together.</p>
                  </div>
                  <div className="mb-3 flex gap-2">
                    <input
                      className="w-full rounded-2xl border px-3 py-2"
                      placeholder="Group name"
                      value={newSettlementGroupName}
                      onChange={(event) => setNewSettlementGroupName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") addSettlementGroup();
                      }}
                    />
                    <button
                      type="button"
                      onClick={addSettlementGroup}
                      className="rounded-2xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700"
                    >
                      Add
                    </button>
                  </div>
                  <div className="space-y-3">
                    {(project.settlementGroups || []).length === 0 ? (
                      <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-500">
                        No settlement groups. Add one to combine people in the final settlement.
                      </div>
                    ) : (
                      (project.settlementGroups || []).map((group) => (
                        <div key={group.id} className="rounded-2xl bg-slate-100 p-3">
                          <div className="mb-2 flex gap-2">
                            <input
                              className="w-full rounded-xl border px-3 py-2 text-sm"
                              value={group.name}
                              onChange={(event) => updateSettlementGroup(group.id, { name: event.target.value })}
                              aria-label="Settlement group name"
                            />
                            <button
                              type="button"
                              onClick={() => removeSettlementGroup(group.id)}
                              className="rounded-xl px-2 py-1 text-sm text-slate-500 hover:bg-red-50 hover:text-red-600"
                            >
                              Remove
                            </button>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {project.participants.map((person) => {
                              const isSelected = group.members.includes(person);
                              return (
                                <button
                                  type="button"
                                  key={person}
                                  onClick={() => toggleSettlementGroupMember(group.id, person)}
                                  className={`rounded-full px-3 py-1 text-xs ${
                                    isSelected ? "bg-slate-900 text-white" : "bg-white text-slate-700"
                                  }`}
                                >
                                  {person}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
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
                  Exchange rate from expense currency
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
                    <SectionIcon>{activeReceipt.receiptType === "rideshare" ? "RS" : "EX"}</SectionIcon>
                    <h2 className="text-xl font-semibold">Active expense</h2>
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
                      onClick={() => {
                        setParserMode("ai-image");
                        fileInputRef.current?.click();
                      }}
                      className="rounded-2xl border px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
                    >
                      Try AI file
                    </button>
                    <button
                      type="button"
                      onClick={duplicateActiveExpense}
                      className="rounded-2xl border px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      onClick={() => removeReceipt(activeReceipt.id)}
                      disabled={project.receipts.length === 1}
                      className="rounded-2xl border px-4 py-2 font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Remove Expense
                    </button>
                    <input ref={fileInputRef} type="file" accept="image/*,application/pdf,.pdf" className="hidden" onChange={handleReceiptUpload} />
                  </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-4">
                  <label className="text-sm">
                    Date
                    <input
                      type="date"
                      className="mt-1 w-full rounded-2xl border px-3 py-2"
                      value={activeReceipt.expenseDate || ""}
                      onChange={(event) => updateActiveReceipt({ expenseDate: event.target.value })}
                    />
                  </label>
                  <label className="text-sm">
                    Trip stop
                    <input
                      className="mt-1 w-full rounded-2xl border px-3 py-2"
                      value={activeReceipt.tripStop || ""}
                      onChange={(event) => updateActiveReceipt({ tripStop: event.target.value })}
                      placeholder="Madrid, Seville, travel day"
                    />
                  </label>
                  <label className="text-sm lg:col-span-2">
                    Activity
                    <input
                      className="mt-1 w-full rounded-2xl border px-3 py-2"
                      value={activeReceipt.activity || ""}
                      onChange={(event) => updateActiveReceipt({ activity: event.target.value })}
                      placeholder="Dinner, train, museum, tapas crawl"
                    />
                  </label>
                  <label className="text-sm lg:col-span-2">
                    Place, merchant, or description
                    <input
                      className="mt-1 w-full rounded-2xl border px-3 py-2"
                      value={activeReceipt.place}
                      onChange={(event) => updateActiveReceipt({ place: event.target.value })}
                    />
                  </label>
                  <label className="text-sm">
                    Expense type
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

                <div className="rounded-2xl border bg-white p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h3 className="font-semibold">Who paid the check</h3>
                      <p className="text-sm text-slate-500">
                        Leave this empty for one payer above, or add each person who paid part of a large group check.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={addPayment}
                      className="rounded-2xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700"
                    >
                      Add payer
                    </button>
                  </div>
                  {(activeReceipt.payments || []).length ? (
                    <div className="mt-3 space-y-2">
                      {(activeReceipt.payments || []).map((payment) => (
                        <div key={payment.id} className="grid gap-2 rounded-2xl bg-slate-50 p-3 md:grid-cols-[1fr_1fr_auto]">
                          <select
                            className="rounded-xl border px-3 py-2"
                            value={payment.person}
                            onChange={(event) => updatePayment(payment.id, { person: event.target.value })}
                          >
                            {project.participants.map((person) => (
                              <option key={person}>{person}</option>
                            ))}
                          </select>
                          <input
                            type="number"
                            className="rounded-xl border px-3 py-2"
                            value={payment.amount}
                            onChange={(event) => updatePayment(payment.id, { amount: event.target.value })}
                            placeholder="Amount paid"
                          />
                          <button
                            type="button"
                            onClick={() => removePayment(payment.id)}
                            className="rounded-xl px-3 py-2 text-sm text-slate-500 hover:bg-red-50 hover:text-red-600"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                      <p className={`text-sm ${Math.abs(activePaymentDifference) < 0.01 ? "text-emerald-700" : "text-amber-700"}`}>
                        Entered payments: {money(activePaymentTotal, activeReceipt.baseCurrency)}. Expense total:{" "}
                        {money(activeCalculations.total, activeReceipt.baseCurrency)}.
                      </p>
                      {Math.abs(activePaymentDifference) >= 0.01 ? (
                        <p className="text-xs text-slate-500">
                          Settlement credits are scaled to the expense total so the overall owed/paid math stays balanced.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div className="rounded-2xl border bg-slate-50 p-3">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-600">Receipt parser</p>
                      <p className="text-sm text-slate-500">{activeReceipt.ocrStatus}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {[
                        ["ai-image", "AI image/PDF"],
                        ["hybrid", "OCR then AI"],
                        ["ocr-only", "OCR only"],
                      ].map(([value, label]) => (
                        <button
                          type="button"
                          key={value}
                          onClick={() => setParserMode(value)}
                          className={`rounded-full px-3 py-1 text-xs font-medium ${
                            parserMode === value ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    AI image/PDF sends the file directly to Gemini and works best for Uber PDFs or messy receipt photos.
                  </p>
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
                    <p className="text-sm text-slate-500">Expense subtotal</p>
                    <p className="text-2xl font-semibold">{money(activeCalculations.subtotal, activeReceipt.baseCurrency)}</p>
                  </div>
                  <div className="rounded-2xl bg-slate-900 p-4 text-white">
                    <p className="text-sm text-slate-300">Expense total</p>
                    <p className="text-2xl font-semibold">{money(activeCalculations.total, activeReceipt.baseCurrency)}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-3xl bg-white shadow-sm">
                <div className="space-y-4 p-5">
                  <div className="flex items-center gap-2">
                    <SectionIcon>BA</SectionIcon>
                    <h2 className="text-xl font-semibold">Balances by person</h2>
                  </div>
                  <div className="space-y-3">
                    {project.participants.map((person) => {
                      const net = projectCalculations.netByPerson[person] || 0;
                      return (
                        <div key={person} className="rounded-2xl bg-slate-100 p-4">
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-semibold">{person}</span>
                            <span className={`font-semibold ${net >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                              {net >= 0 ? "Gets back " : "Owes "}
                              {money(Math.abs(net), activeReceipt.baseCurrency)}
                            </span>
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-slate-600">
                            <div className="rounded-xl bg-white p-3">
                              <p>Paid</p>
                              <p className="font-semibold text-slate-900">
                                {money(projectCalculations.paidByPerson[person], activeReceipt.baseCurrency)}
                              </p>
                            </div>
                            <div className="rounded-xl bg-white p-3">
                              <p>Used / shared</p>
                              <p className="font-semibold text-slate-900">
                                {money(projectCalculations.owedByPerson[person], activeReceipt.baseCurrency)}
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="rounded-3xl bg-white shadow-sm">
                <div className="space-y-4 p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2">
                      <SectionIcon>AU</SectionIcon>
                      <h2 className="text-xl font-semibold">Charge audit</h2>
                    </div>
                    <select
                      className="rounded-2xl border px-3 py-2 text-sm"
                      value={activeAuditPerson}
                      onChange={(event) => setAuditPerson(event.target.value)}
                    >
                      {project.participants.map((person) => (
                        <option key={person}>{person}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-sm text-slate-600">
                    <div className="rounded-xl bg-slate-100 p-3">
                      <p>Used</p>
                      <p className="font-semibold text-slate-900">{money(participantAudit.owed, activeReceipt.baseCurrency)}</p>
                    </div>
                    <div className="rounded-xl bg-slate-100 p-3">
                      <p>Paid</p>
                      <p className="font-semibold text-slate-900">{money(participantAudit.paid, activeReceipt.baseCurrency)}</p>
                    </div>
                    <div className="rounded-xl bg-slate-100 p-3">
                      <p>{participantAudit.net >= 0 ? "Gets back" : "Owes"}</p>
                      <p className="font-semibold text-slate-900">{money(Math.abs(participantAudit.net), activeReceipt.baseCurrency)}</p>
                    </div>
                  </div>
                  <div className="max-h-[34rem] space-y-3 overflow-y-auto pr-1">
                    {participantAudit.receiptAudits.length === 0 ? (
                      <div className="rounded-2xl bg-green-50 p-4 text-sm text-green-700">No charges found for this person.</div>
                    ) : (
                      participantAudit.receiptAudits.map(({ receipt, owed, paid, net, itemCharges }) => (
                        <div key={receipt.id} className="rounded-2xl border bg-white p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-semibold">{receipt.place}</p>
                              <p className="text-xs text-slate-500">
                                {[receipt.expenseDate, receipt.tripStop, receipt.activity].filter(Boolean).join(" | ") ||
                                  expenseTypeLabel(receipt.receiptType)}
                              </p>
                            </div>
                            <div className="text-right text-sm">
                              <p>Used {money(owed, receipt.baseCurrency)}</p>
                              {paid > 0 && <p className="text-emerald-700">Paid {money(paid, receipt.baseCurrency)}</p>}
                              {Math.abs(net) > 0.01 && (
                                <p className={net >= 0 ? "text-emerald-700" : "text-red-700"}>
                                  {net >= 0 ? "Net +" : "Net -"}
                                  {money(Math.abs(net), receipt.baseCurrency)}
                                </p>
                              )}
                            </div>
                          </div>
                          {itemCharges.length > 0 && (
                            <div className="mt-3 space-y-2">
                              {itemCharges.map((item) => (
                                <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2 text-sm">
                                  <div>
                                    <p className="font-medium">{item.name}</p>
                                    <p className="text-xs text-slate-500">
                                      {item.category} split {item.sharedCount} ways
                                    </p>
                                  </div>
                                  <span className="font-semibold">{money(item.amount, receipt.baseCurrency)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                  {(participantAudit.sentPayments.length > 0 || participantAudit.receivedPayments.length > 0) && (
                    <div className="rounded-2xl bg-slate-50 p-4 text-sm">
                      <p className="mb-2 font-semibold">Settlement payments recorded</p>
                      {[...participantAudit.sentPayments, ...participantAudit.receivedPayments].map((payment) => (
                        <div key={payment.id} className="flex justify-between gap-3 py-1 text-slate-700">
                          <span>
                            {payment.from} paid {payment.to}
                            {payment.note ? ` for ${payment.note}` : ""}
                          </span>
                          <span className="font-semibold">{money(payment.amount, project.settlementCurrency)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-3xl bg-white shadow-sm lg:col-span-2">
                <div className="space-y-4 p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h2 className="text-xl font-semibold">Project settlement</h2>
                      <p className="text-sm text-slate-500">
                        {effectiveSettlementMode === "groups"
                          ? "Grouped mode nets selected groups first, then shows the simplest final payments."
                          : "Individual mode shows exact person-to-person reimbursements for each shared expense."}
                      </p>
                    </div>
                    <div className="inline-flex rounded-2xl bg-slate-100 p-1 text-sm font-medium">
                      <button
                        type="button"
                        onClick={() => setSettlementMode("groups")}
                        className={`rounded-xl px-3 py-2 ${
                          settlementMode === "groups" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"
                        }`}
                      >
                        Groups
                      </button>
                      <button
                        type="button"
                        onClick={() => setSettlementMode("individual")}
                        className={`rounded-xl px-3 py-2 ${
                          settlementMode === "individual" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"
                        }`}
                      >
                        Individuals
                      </button>
                    </div>
                  </div>
                  {settlementMode === "groups" && activeSettlementGroups.length === 0 && (
                    <div className="rounded-2xl bg-amber-50 p-3 text-sm text-amber-800">
                      Add at least two people to a settlement group to use grouped settlement.
                    </div>
                  )}
                  {effectiveSettlementMode === "groups" && (
                    <div className="flex flex-wrap gap-2">
                      {activeSettlementGroups.map((group) => (
                        <span key={group.id} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                          {group.name}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className={`text-sm ${Math.abs(projectNetTotal) < 0.01 ? "text-emerald-700" : "text-amber-700"}`}>
                    Balance check:{" "}
                    {Math.abs(projectNetTotal) < 0.01
                      ? "owed and paid totals match"
                      : `${money(Math.abs(projectNetTotal), activeReceipt.baseCurrency)} off balance`}
                  </p>
                  <div className="rounded-2xl bg-slate-50 p-4">
                    <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h3 className="font-semibold">Payments already sent</h3>
                        <p className="text-sm text-slate-500">
                          Recorded payments subtract from the final settlement total.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={addSettlementPayment}
                        className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
                      >
                        Add payment
                      </button>
                    </div>
                    {(project.settlementPayments || []).length === 0 ? (
                      <div className="rounded-xl bg-white p-3 text-sm text-slate-500">
                        No settlement payments recorded yet.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {(project.settlementPayments || []).map((payment) => (
                          <div key={payment.id} className="grid gap-2 rounded-xl bg-white p-3 md:grid-cols-[1fr_1fr_8rem_1fr_auto]">
                            <select
                              className="rounded-xl border px-3 py-2 text-sm"
                              value={payment.from}
                              onChange={(event) => updateSettlementPayment(payment.id, { from: event.target.value })}
                            >
                              {project.participants.map((name) => (
                                <option key={name}>{name}</option>
                              ))}
                            </select>
                            <select
                              className="rounded-xl border px-3 py-2 text-sm"
                              value={payment.to}
                              onChange={(event) => updateSettlementPayment(payment.id, { to: event.target.value })}
                            >
                              {project.participants.map((name) => (
                                <option key={name}>{name}</option>
                              ))}
                            </select>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              className="rounded-xl border px-3 py-2 text-sm"
                              value={payment.amount}
                              onChange={(event) => updateSettlementPayment(payment.id, { amount: event.target.value })}
                              placeholder={project.settlementCurrency}
                            />
                            <input
                              className="rounded-xl border px-3 py-2 text-sm"
                              value={payment.note || ""}
                              onChange={(event) => updateSettlementPayment(payment.id, { note: event.target.value })}
                              placeholder="Meal, ride, Venmo, etc."
                            />
                            <button
                              type="button"
                              onClick={() => removeSettlementPayment(payment.id)}
                              className="rounded-xl px-2 py-1 text-sm text-slate-500 hover:bg-red-50 hover:text-red-600"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {recordedPaymentTotal > 0 && (
                      <p className="mt-3 text-sm font-medium text-slate-700">
                        Recorded: {money(recordedPaymentTotal, project.settlementCurrency)}
                      </p>
                    )}
                  </div>
                  {convertedSettlements.length === 0 ? (
                    <div className="rounded-2xl bg-green-50 p-4 text-green-700">Everyone is settled.</div>
                  ) : (
                    convertedSettlements.map((settlement) => (
                      <div key={`${settlement.from}-${settlement.to}`} className="rounded-2xl border bg-white p-4">
                        <p className="font-medium">
                          {settlement.from} pays {settlement.to}
                        </p>
                        <p className="text-2xl font-bold">{money(settlement.convertedAmount, project.settlementCurrency)}</p>
                        {recordedPaymentTotal > 0 && <p className="text-sm text-emerald-700">Remaining after recorded payments</p>}
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

