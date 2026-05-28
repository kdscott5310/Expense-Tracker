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

export function getProjectIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("project");
}

export function setProjectIdInUrl(id) {
  const url = new URL(window.location.href);
  url.searchParams.set("project", id);
  window.history.replaceState({}, "", url);
}

export async function loadProjectFromSupabase(id) {
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .single();

  if (projectError) throw projectError;

  const [{ data: members, error: membersError }, { data: receipts, error: receiptsError }] = await Promise.all([
    supabase.from("project_members").select("*").eq("project_id", id).order("created_at"),
    supabase.from("receipts").select("*").eq("project_id", id).order("created_at"),
  ]);

  if (membersError) throw membersError;
  if (receiptsError) throw receiptsError;

  const receiptIds = receipts.map((receipt) => receipt.id);
  const { data: items, error: itemsError } = receiptIds.length
    ? await supabase.from("receipt_items").select("*").in("receipt_id", receiptIds).order("created_at")
    : { data: [], error: null };

  if (itemsError) throw itemsError;

  return {
    id: project.id,
    name: project.name,
    settlementCurrency: project.settlement_currency || "USD",
    exchangeRate: project.exchange_rate || 1,
    participants: members.map((member) => member.name),
    receipts: receipts.map((receipt) => ({
      id: receipt.id,
      place: receipt.place || "Untitled expense",
      merchant: receipt.merchant || "",
      receiptType: receipt.receipt_type || "restaurant",
      paidBy: receipt.paid_by || "",
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

export async function saveProjectToSupabase(project) {
  const id = projectId(project);
  const receiptsWithIds = project.receipts.map((receipt) => ({
    ...receipt,
    id: receiptId(receipt),
  }));

  const { error: projectError } = await supabase.from("projects").upsert({
    id,
    name: project.name,
    settlement_currency: project.settlementCurrency,
    exchange_rate: Number(project.exchangeRate || 1),
  });

  if (projectError) throw projectError;

  const [{ error: deleteMembersError }, { error: deleteReceiptsError }] = await Promise.all([
    supabase.from("project_members").delete().eq("project_id", id),
    supabase.from("receipts").delete().eq("project_id", id),
  ]);

  if (deleteMembersError) throw deleteMembersError;
  if (deleteReceiptsError) throw deleteReceiptsError;

  if (project.participants.length) {
    const { error } = await supabase.from("project_members").insert(
      project.participants.map((name) => ({
        project_id: id,
        name,
      })),
    );
    if (error) throw error;
  }

  if (receiptsWithIds.length) {
    const { error } = await supabase.from("receipts").insert(
      receiptsWithIds.map((receipt) => ({
        id: receipt.id,
        project_id: id,
        place: receipt.place,
        merchant: receipt.merchant,
        receipt_type: receipt.receiptType,
        paid_by: receipt.paidBy,
        base_currency: receipt.baseCurrency,
        tax_tip: Number(receipt.taxTip || 0),
        ocr_text: receipt.ocrText,
      })),
    );
    if (error) throw error;
  }

  const receiptItems = receiptsWithIds.flatMap((receipt) =>
    receipt.items.map((item) => ({
      receipt_id: receipt.id,
      name: item.name,
      category: item.category,
      amount: Number(item.amount || 0),
      shared_by: item.sharedBy,
    })),
  );

  if (receiptItems.length) {
    const { error } = await supabase.from("receipt_items").insert(receiptItems);
    if (error) throw error;
  }

  return {
    ...project,
    id,
    receipts: receiptsWithIds,
  };
}
