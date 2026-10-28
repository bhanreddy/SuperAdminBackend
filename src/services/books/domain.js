const { randomUUID } = require('node:crypto');
class BooksError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const ensure = (condition, message, status = 400) => {
  if (!condition) throw new BooksError(message, status);
};
const text = (value, max = 500) =>
  String(value ?? '')
    .trim()
    .slice(0, max);
const required = (value, name) => {
  const s = text(value);
  ensure(s, `${name} is required`);
  return s;
};
function date(value, name = 'Date') {
  const s = String(value || '');
  const parsed = new Date(`${s}T00:00:00Z`);
  ensure(
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === s,
    `${name} must be a valid YYYY-MM-DD date`,
  );
  return s;
}
function scaled(
  value,
  places,
  name,
  { positive = false, signed = false } = {},
) {
  const str = String(value ?? '0').trim();
  ensure(
    new RegExp(`^${signed ? '-?' : ''}\\d+(?:\\.\\d{1,${places}})?$`).test(str),
    `${name} must have at most ${places} decimal places`,
  );
  const negative = str.startsWith('-');
  const [whole, fraction = ''] = str.replace('-', '').split('.');
  const n =
    Number(
      BigInt(whole) * 10n ** BigInt(places) +
        BigInt(fraction.padEnd(places, '0')),
    ) * (negative ? -1 : 1);
  ensure(
    Number.isSafeInteger(n) && Math.abs(n) <= 1e12 && (!positive || n > 0),
    `${name} is outside the supported range`,
  );
  return n;
}
const money = (n, name = 'Amount', opts) => scaled(n, 2, name, opts);
const quantity = (n) => scaled(n, 3, 'Quantity', { positive: true });
const rounded = (value, denominator) =>
  Number((value + denominator / 2n) / denominator);
const uuid = (value) => {
  ensure(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      String(value),
    ),
    'Invalid record identifier',
  );
  return value;
};
const KINDS = [
  'quote',
  'sales_order',
  'invoice',
  'credit_note',
  'purchase_order',
  'bill',
  'expense',
  'vendor_credit',
  'delivery_challan',
];
const POSTING = ['invoice', 'credit_note', 'bill', 'expense', 'vendor_credit'];
const SALES = [
  'quote',
  'sales_order',
  'invoice',
  'credit_note',
  'delivery_challan',
];
const PREFIX = {
  quote: 'QT',
  sales_order: 'SO',
  invoice: 'INV',
  credit_note: 'CN',
  purchase_order: 'PO',
  bill: 'BILL',
  expense: 'EXP',
  vendor_credit: 'VC',
  journal: 'JRN',
  delivery_challan: 'DC',
};
function calculateLines(input, interstate, options = {}) {
  ensure(
    Array.isArray(input) && input.length > 0 && input.length <= 100,
    'Add between 1 and 100 line items',
  );
  const discountType = options.discount_type || 'amount';
  ensure(
    ['amount', 'percent'].includes(discountType),
    'Invalid document discount type',
  );
  const discountValue = money(options.discount_value ?? 0, 'Document discount');
  if (discountType === 'percent')
    ensure(discountValue <= 10000, 'Document discount cannot exceed 100%');
  const lines = input.map((line) => {
    const units = quantity(line.quantity ?? 1),
      rate = money(line.rate, 'Rate'),
      discount = money(line.discount ?? 0, 'Line discount');
    const taxRate = scaled(line.tax_rate ?? 0, 2, 'Tax rate');
    ensure(taxRate <= 10000, 'Tax rate cannot exceed 100%');
    const gross = rounded(BigInt(units) * BigInt(rate), 1000n);
    ensure(
      Number.isSafeInteger(gross) && gross <= 1e12,
      'Line amount is outside the supported range',
    );
    ensure(discount <= gross, 'Discount cannot exceed the line amount');
    return {
      item_id: line.item_id ? uuid(line.item_id) : null,
      description: required(line.description, 'Description'),
      hsn_sac: text(line.hsn_sac, 30),
      quantity_milli: units,
      rate,
      discount,
      tax_rate: taxRate,
      amount: gross - discount,
      tax: 0,
      document_discount: 0,
    };
  });
  const base = lines.reduce((sum, l) => sum + l.amount, 0);
  ensure(
    Number.isSafeInteger(base) && base <= 1e12,
    'Document amount is outside the supported range',
  );
  const discountTotal =
    discountType === 'percent'
      ? rounded(BigInt(base) * BigInt(discountValue), 10000n)
      : discountValue;
  ensure(discountTotal <= base, 'Document discount cannot exceed subtotal');
  let cumulative = 0,
    allocated = 0,
    tax = 0,
    cgst = 0,
    sgst = 0,
    igst = 0;
  for (const line of lines) {
    cumulative += line.amount;
    const through = base
      ? Number((BigInt(discountTotal) * BigInt(cumulative)) / BigInt(base))
      : 0;
    line.document_discount = through - allocated;
    allocated = through;
    line.amount -= line.document_discount;
    line.tax = rounded(BigInt(line.amount) * BigInt(line.tax_rate), 10000n);
    tax += line.tax;
    const cg = interstate ? 0 : Math.floor(line.tax / 2);
    cgst += cg;
    sgst += interstate ? 0 : line.tax - cg;
    igst += interstate ? line.tax : 0;
  }
  const subtotal = base - discountTotal,
    adjustment = money(options.adjustment ?? 0, 'Adjustment', { signed: true }),
    total = subtotal + tax + adjustment;
  ensure(
    Number.isSafeInteger(total) &&
      total <= 1e12 &&
      (options.allow_zero ? total >= 0 : total > 0),
    'Document total must be positive and within the supported range',
  );
  return {
    lines,
    subtotal,
    tax,
    total,
    subtotal_before_discount: base,
    discount_type: discountType,
    discount_value: discountValue,
    discount_total: discountTotal,
    adjustment,
    tax_breakup: { cgst, sgst, igst },
  };
}
function balanced(lines) {
  ensure(
    Array.isArray(lines) && lines.length >= 2 && lines.length <= 200,
    'A journal requires 2–200 lines',
  );
  let debit = 0,
    credit = 0;
  for (const l of lines) {
    const d = Number(l.debit || 0),
      c = Number(l.credit || 0);
    ensure(
      Number.isSafeInteger(d) &&
        Number.isSafeInteger(c) &&
        d >= 0 &&
        c >= 0 &&
        ((d > 0 && c === 0) || (c > 0 && d === 0)),
      'Each journal line must have exactly one positive debit or credit',
    );
    debit += d;
    credit += c;
  }
  ensure(
    Number.isSafeInteger(debit) &&
      Number.isSafeInteger(credit) &&
      debit === credit,
    'Journal debits and credits must balance',
  );
  return lines;
}
function nextMonth(value, months) {
  const d = new Date(`${date(value)}T00:00:00Z`),
    day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const max = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, max));
  return d.toISOString().slice(0, 10);
}
module.exports = {
  BooksError,
  ensure,
  text,
  required,
  date,
  money,
  quantity,
  uuid,
  randomUUID,
  KINDS,
  POSTING,
  SALES,
  PREFIX,
  calculateLines,
  balanced,
  nextMonth,
  rounded,
};
