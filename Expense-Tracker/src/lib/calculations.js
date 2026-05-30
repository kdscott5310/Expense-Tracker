export const currencySymbols = {
  USD: "$",
  EUR: "EUR ",
  GBP: "GBP ",
  CAD: "C$",
  MXN: "MX$",
};

export function money(value, currency = "USD") {
  const symbol = currencySymbols[currency] || `${currency} `;
  return `${symbol}${Number(value || 0).toFixed(2)}`;
}

export function splitEvenly(amount, names) {
  if (!names.length) return {};
  const share = amount / names.length;
  return Object.fromEntries(names.map((name) => [name, share]));
}

export function simplifyDebts(netByPerson) {
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
    if (debtors[i].amount < 0.01) i += 1;
    if (creditors[j].amount < 0.01) j += 1;
  }

  return settlements;
}

export function distributeDebtsProportionally(netByPerson) {
  const debtors = Object.entries(netByPerson)
    .filter(([, amount]) => amount < -0.01)
    .map(([name, amount]) => ({ name, amount: -amount }));
  const creditors = Object.entries(netByPerson)
    .filter(([, amount]) => amount > 0.01)
    .map(([name, amount]) => ({ name, amount }));
  const totalCredit = creditors.reduce((sum, creditor) => sum + creditor.amount, 0);

  if (!totalCredit) return [];

  return debtors.flatMap((debtor) =>
    creditors
      .map((creditor) => ({
        from: debtor.name,
        to: creditor.name,
        amount: (debtor.amount * creditor.amount) / totalCredit,
      }))
      .filter((settlement) => settlement.amount > 0.01),
  );
}

export function calculatePayerReimbursements(receiptSummaries, participants) {
  const directedDebts = new Map();

  const addDebt = (from, to, amount) => {
    if (!from || !to || from === to || amount <= 0.01) return;
    const key = `${from}\u0000${to}`;
    directedDebts.set(key, (directedDebts.get(key) || 0) + amount);
  };

  receiptSummaries.forEach(({ calculations }) => {
    const payers = participants
      .map((person) => ({ person, amount: calculations.paidByPerson[person] || 0 }))
      .filter((payer) => payer.amount > 0.01);
    const totalPaid = payers.reduce((sum, payer) => sum + payer.amount, 0);

    if (!totalPaid) return;

    participants.forEach((debtor) => {
      const owed = calculations.owedByPerson[debtor] || 0;
      if (owed <= 0.01) return;

      payers.forEach((payer) => {
        addDebt(debtor, payer.person, (owed * payer.amount) / totalPaid);
      });
    });
  });

  const settlements = [];
  const handledPairs = new Set();

  directedDebts.forEach((amount, key) => {
    const [from, to] = key.split("\u0000");
    const pairKey = [from, to].sort().join("\u0000");
    if (handledPairs.has(pairKey)) return;

    const reverseAmount = directedDebts.get(`${to}\u0000${from}`) || 0;
    const netAmount = amount - reverseAmount;

    if (netAmount > 0.01) settlements.push({ from, to, amount: netAmount });
    if (netAmount < -0.01) settlements.push({ from: to, to: from, amount: Math.abs(netAmount) });

    handledPairs.add(pairKey);
  });

  return settlements.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

export function groupSettlementEntries(settlements, groups = []) {
  if (!groups.length) return settlements;

  const personToGroup = new Map();
  groups.forEach((group) => {
    group.members.forEach((member) => {
      personToGroup.set(member, group.name);
    });
  });

  const groupedDebts = new Map();

  settlements.forEach((settlement) => {
    const from = personToGroup.get(settlement.from) || settlement.from;
    const to = personToGroup.get(settlement.to) || settlement.to;
    if (from === to) return;

    const key = `${from}\u0000${to}`;
    groupedDebts.set(key, (groupedDebts.get(key) || 0) + settlement.amount);
  });

  const groupedSettlements = [];
  const handledPairs = new Set();

  groupedDebts.forEach((amount, key) => {
    const [from, to] = key.split("\u0000");
    const pairKey = [from, to].sort().join("\u0000");
    if (handledPairs.has(pairKey)) return;

    const reverseAmount = groupedDebts.get(`${to}\u0000${from}`) || 0;
    const netAmount = amount - reverseAmount;

    if (netAmount > 0.01) groupedSettlements.push({ from, to, amount: netAmount });
    if (netAmount < -0.01) groupedSettlements.push({ from: to, to: from, amount: Math.abs(netAmount) });

    handledPairs.add(pairKey);
  });

  return groupedSettlements.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

export function applyRecordedSettlementPayments(settlements, payments = []) {
  const directedDebts = new Map();

  const addDebt = (from, to, amount) => {
    if (!from || !to || from === to || amount <= 0.01) return;
    const key = `${from}\u0000${to}`;
    directedDebts.set(key, (directedDebts.get(key) || 0) + amount);
  };

  settlements.forEach((settlement) => {
    addDebt(settlement.from, settlement.to, Number(settlement.amount || 0));
  });

  payments.forEach((payment) => {
    const amount = Number(payment.amount || 0);
    if (!payment.from || !payment.to || amount <= 0.01) return;
    addDebt(payment.to, payment.from, amount);
  });

  const remainingSettlements = [];
  const handledPairs = new Set();

  directedDebts.forEach((amount, key) => {
    const [from, to] = key.split("\u0000");
    const pairKey = [from, to].sort().join("\u0000");
    if (handledPairs.has(pairKey)) return;

    const reverseAmount = directedDebts.get(`${to}\u0000${from}`) || 0;
    const netAmount = amount - reverseAmount;

    if (netAmount > 0.01) remainingSettlements.push({ from, to, amount: netAmount });
    if (netAmount < -0.01) remainingSettlements.push({ from: to, to: from, amount: Math.abs(netAmount) });

    handledPairs.add(pairKey);
  });

  return remainingSettlements.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

export function calculateReceiptSplit({ items, participants, paidBy, taxTip, payments = [] }) {
  const subtotal = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const multiplier = 1 + Number(taxTip || 0) / 100;
  const total = subtotal * multiplier;
  const owedByPerson = Object.fromEntries(participants.map((person) => [person, 0]));

  items.forEach((item) => {
    const participantsForItem = item.sharedBy.length ? item.sharedBy : participants;
    const allocations = splitEvenly(Number(item.amount || 0) * multiplier, participantsForItem);
    Object.entries(allocations).forEach(([person, amount]) => {
      owedByPerson[person] = (owedByPerson[person] || 0) + amount;
    });
  });

  const paidByPerson = Object.fromEntries(participants.map((person) => [person, 0]));
  const validPayments = payments
    .filter((payment) => payment.person && participants.includes(payment.person))
    .map((payment) => ({ ...payment, amount: Number(payment.amount || 0) }))
    .filter((payment) => payment.amount > 0);
  const enteredPaymentTotal = validPayments.reduce((sum, payment) => sum + payment.amount, 0);

  if (validPayments.length) {
    const paymentScale = enteredPaymentTotal ? total / enteredPaymentTotal : 1;
    validPayments.forEach((payment) => {
      paidByPerson[payment.person] = (paidByPerson[payment.person] || 0) + payment.amount * paymentScale;
    });
  } else if (paidBy) {
    paidByPerson[paidBy] = total;
  }

  const netByPerson = Object.fromEntries(
    participants.map((person) => [person, (paidByPerson[person] || 0) - (owedByPerson[person] || 0)]),
  );

  return {
    subtotal,
    total,
    enteredPaymentTotal,
    owedByPerson,
    paidByPerson,
    netByPerson,
    settlements: simplifyDebts(netByPerson),
  };
}
