import { supabase } from "./supabaseClient";

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || "");
}

function projectId(project) {
  return isUuid(project.id) ? project.id : crypto.randomUUID();
}

function receiptId(receipt) {
  return isUuid(receipt.id) ? receipt.id : crypto.randomUUID();
}

function itemId(item) {
  return isUuid(item.id) ? item.id : crypto.randomUUID();
}

function isMissingColumnError(error) {
  return /column .* does not exist|could not find .* column/i.test(error?.message || "");
}

export function createTripCode(name = "trip") {
  const slug = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 14);
  const suffix = crypto.randomUUID().slice(0, 6).toUpperCase();
  return `${slug || "TRIP"}-${suffix}`;
}

export function normalizeTripCode(code = "") {
  return code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function getProjectIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("project");
}

export function setProjectIdInUrl(id) {
  const url = new URL(window.location.href);
  url.searchParams.set("project", id);
  window.history.replaceState({}, "", url);
}

export function clearProjectIdInUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("project");
  window.history.replaceState({}, "", url);
}

export async function findProjectIdByName(name) {
  const cleanName = name.trim();
  if (!cleanName) return null;

  const { data, error } = await supabase
    .from("projects")
    .select("id")
    .eq("name", cleanName)
    .limit(1);

  if (error) throw error;
  return data?.[0]?.id || null;
}

export async function findProjectIdByTripCode(code) {
  const cleanCode = normalizeTripCode(code);
  if (!cleanCode) return null;

  const { data, error } = await supabase
    .from("projects")
    .select("id")
    .eq("trip_code", cleanCode)
    .limit(1);

  if (error) throw error;
  return data?.[0]?.id || null;
}

export async function listUserProjects(userId) {
  if (!userId) return [];

  const { data, error } = await supabase
    .from("projects")
    .select("id, name, trip_code")
    .eq("owner_id", userId)
    .order("name");

  if (error) throw error;
  return data || [];
}

export async function loadProjectFromSupabase(id) {
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .single();

  if (projectError) throw projectError;

  const [{ data: members, error: membersError }, { data: receipts, error: receiptsError }] = await Promise.all([
    supabase.from("project_members").select("*").eq("project_id", id).order("name"),
    supabase.from("receipts").select("*").eq("project_id", id).order("id"),
  ]);

  if (membersError) throw membersError;
  if (receiptsError) throw receiptsError;

  const receiptIds = receipts.map((receipt) => receipt.id);
  const { data: items, error: itemsError } = receiptIds.length
    ? await supabase.from("receipt_items").select("*").in("receipt_id", receiptIds).order("id")
    : { data: [], error: null };

  if (itemsError) throw itemsError;

  return {
    id: project.id,
    name: project.name,
    tripCode: project.trip_code || "",
    serverSyncedAt: project.last_synced_at || project.created_at || "",
    settlementCurrency: project.settlement_currency || "USD",
    exchangeRate: project.exchange_rate || 1,
    settlementGroups: Array.isArray(project.settlement_groups) ? project.settlement_groups : undefined,
    settlementPayments: Array.isArray(project.settlement_payments) ? project.settlement_payments : [],
    discrepancies: Array.isArray(project.discrepancies) ? project.discrepancies : [],
    participants: members.map((member) => member.name),
    receipts: receipts.map((receipt) => ({
      id: receipt.id,
      place: receipt.place || "Untitled expense",
      merchant: receipt.merchant || "",
      receiptType: receipt.receipt_type || "restaurant",
      paidBy: receipt.paid_by || "",
      expenseDate: receipt.expense_date || "",
      tripStop: receipt.trip_stop || "",
      activity: receipt.activity || "",
      payments: Array.isArray(receipt.payments) ? receipt.payments : [],
      baseCurrency: receipt.base_currency || "USD",
      taxTip: receipt.tax_tip || 0,
      ocrText: receipt.ocr_text || "",
      ocrStatus: "Loaded from Supabase.",
      items: items
        .filter((item) => item.receipt_id === receipt.id)
        .map((item) => ({
          id: item.id,
          name: item.name,
          category: item.category || "Receipt item",
          amount: Number(item.amount || 0),
          sharedBy: Array.isArray(item.shared_by) ? item.shared_by : [],
        })),
    })),
  };
}

export async function saveProjectToSupabase(project, options = {}) {
  const id = projectId(project);
  const tripCode = normalizeTripCode(project.tripCode || (options.userId ? createTripCode(project.name) : ""));
  const syncTimestamp = new Date().toISOString();
  const receiptsWithIds = project.receipts.map((receipt) => ({
    ...receipt,
    id: receiptId(receipt),
    items: receipt.items.map((item) => ({
      ...item,
      id: itemId(item),
    })),
  }));

  const projectRow = {
    id,
    name: project.name,
    settlement_currency: project.settlementCurrency,
    exchange_rate: Number(project.exchangeRate || 1),
    settlement_groups: project.settlementGroups || [],
    settlement_payments: project.settlementPayments || [],
    discrepancies: project.discrepancies || [],
    last_synced_at: syncTimestamp,
  };

  if (options.userId) projectRow.owner_id = options.userId;
  if (tripCode) projectRow.trip_code = tripCode;

  let { error: projectError } = await supabase.from("projects").upsert(projectRow);

  for (let attempt = 0; projectError && attempt < 4; attempt += 1) {
    const message = String(projectError.message || "");
    let removedMissingColumn = false;

    if (message.includes("last_synced_at") && "last_synced_at" in projectRow) {
      delete projectRow.last_synced_at;
      removedMissingColumn = true;
    }

    if (isMissingColumnError(projectError)) {
      if (message.includes("settlement_groups") && "settlement_groups" in projectRow) {
        delete projectRow.settlement_groups;
        removedMissingColumn = true;
      }

      if (message.includes("settlement_payments") && "settlement_payments" in projectRow) {
        delete projectRow.settlement_payments;
        removedMissingColumn = true;
      }

      if (message.includes("discrepancies") && "discrepancies" in projectRow) {
        delete projectRow.discrepancies;
        removedMissingColumn = true;
      }
    }

    if (!removedMissingColumn) break;

    const retry = await supabase.from("projects").upsert(projectRow);
    projectError = retry.error;
  }

  if (projectError) throw projectError;

  const [{ data: existingMembers, error: existingMembersError }, { data: existingReceipts, error: existingReceiptsError }] = await Promise.all([
    supabase.from("project_members").select("name").eq("project_id", id),
    supabase.from("receipts").select("id").eq("project_id", id),
  ]);

  if (existingMembersError) throw existingMembersError;
  if (existingReceiptsError) throw existingReceiptsError;

  const existingMemberNames = new Set((existingMembers || []).map((member) => member.name));
  const newMembers = project.participants.filter((name) => !existingMemberNames.has(name));

  if (newMembers.length) {
    const { error } = await supabase.from("project_members").insert(
      newMembers.map((name) => ({
        project_id: id,
        name,
      })),
    );
    if (error) throw error;
  }

  const existingReceiptIds = new Set((existingReceipts || []).map((receipt) => receipt.id));
  const receiptsToUpsert = receiptsWithIds.filter((receipt) => existingReceiptIds.has(receipt.id));
  const receiptsToInsert = receiptsWithIds.filter((receipt) => !existingReceiptIds.has(receipt.id));

  const receiptRows = (receipts, includeMetadata = true) =>
    receipts.map((receipt) => {
      const row = {
      id: receipt.id,
      project_id: id,
      place: receipt.place,
      merchant: receipt.merchant,
      receipt_type: receipt.receiptType,
      paid_by: receipt.paidBy,
      base_currency: receipt.baseCurrency,
      tax_tip: Number(receipt.taxTip || 0),
      ocr_text: receipt.ocrText,
      };

      if (includeMetadata) {
        row.expense_date = receipt.expenseDate || null;
        row.trip_stop = receipt.tripStop || "";
        row.activity = receipt.activity || "";
        row.payments = receipt.payments || [];
      }

      return row;
    });

  let includeReceiptMetadata = true;

  if (receiptsToUpsert.length) {
    let { error } = await supabase.from("receipts").upsert(receiptRows(receiptsToUpsert, includeReceiptMetadata));
    if (error && isMissingColumnError(error)) {
      includeReceiptMetadata = false;
      const retry = await supabase.from("receipts").upsert(receiptRows(receiptsToUpsert, includeReceiptMetadata));
      error = retry.error;
    }
    if (error) throw error;
  }

  if (receiptsToInsert.length) {
    const { error } = await supabase.from("receipts").insert(receiptRows(receiptsToInsert, includeReceiptMetadata));
    if (error) throw error;
  }

  const receiptItems = receiptsWithIds.flatMap((receipt) =>
    receipt.items.map((item) => ({
      id: item.id,
      receipt_id: receipt.id,
      name: item.name,
      category: item.category,
      amount: Number(item.amount || 0),
      shared_by: item.sharedBy,
    })),
  );

  if (receiptItems.length) {
    const { error } = await supabase.from("receipt_items").upsert(receiptItems);
    if (error) throw error;
  }

  return {
    ...project,
    id,
    tripCode,
    serverSyncedAt: projectRow.last_synced_at || project.serverSyncedAt || "",
    settlementGroups: project.settlementGroups || [],
    settlementPayments: project.settlementPayments || [],
    discrepancies: project.discrepancies || [],
    receipts: receiptsWithIds,
  };
}
