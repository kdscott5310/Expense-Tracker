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

export function calculateReceiptSplit({ items, participants, paidBy, taxTip }) {
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

  const paidByPerson = Object.fromEntries(participants.map((person) => [person, person === paidBy ? total : 0]));
  const netByPerson = Object.fromEntries(
    participants.map((person) => [person, (paidByPerson[person] || 0) - (owedByPerson[person] || 0)]),
  );

  return {
    subtotal,
    total,
    owedByPerson,
    paidByPerson,
    netByPerson,
    settlements: simplifyDebts(netByPerson),
  };
}
