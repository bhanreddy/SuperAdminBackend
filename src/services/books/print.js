const escape = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const money = (v) =>
  `INR ${(Number(v) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function printDocument(doc) {
  const org = doc.organization_snapshot,
    c = doc.contact_snapshot;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(doc.number)}</title><style>
 body{font:14px system-ui,sans-serif;color:#17283b;max-width:880px;margin:48px auto;padding:24px}h1{font-size:32px}header{display:flex;justify-content:space-between;gap:40px}p{white-space:pre-line;line-height:1.6}table{width:100%;border-collapse:collapse;margin:32px 0}th,td{padding:12px;text-align:left;border-bottom:1px solid #dce3eb}th{background:#f4f7fb}.right{text-align:right}.total{font-size:22px;font-weight:700}footer{margin-top:36px;color:#5b6d80}@media print{body{margin:0}button{display:none}}</style></head><body>
 <header><div><h2>${escape(org.organization_name)}</h2><p>${escape(org.address)}${org.gstin ? '\nGSTIN: ' + escape(org.gstin) : ''}</p></div><div><h1>${escape(doc.kind.replaceAll('_', ' ').toUpperCase())}</h1><p>${escape(doc.number)}\nStatus: ${escape(doc.status)}\nDate: ${escape(doc.date)}${doc.kind !== 'delivery_challan' && doc.due_date ? '\nDue: ' + escape(doc.due_date) : ''}</p></div></header>
 <h3>${['bill', 'purchase_order', 'vendor_credit', 'expense'].includes(doc.kind) ? 'Vendor' : 'Bill to'}</h3><p>${escape(c.name)}\n${escape(c.address)}${c.gstin ? '\nGSTIN: ' + escape(c.gstin) : ''}</p>
 <p>Reference: ${escape(doc.reference)}${doc.subject ? '\nSubject: ' + escape(doc.subject) : ''}${doc.salesperson ? '\nSalesperson: ' + escape(doc.salesperson) : ''}${doc.challan_type ? '\nChallan type: ' + escape(doc.challan_type.replaceAll('_', ' ')) : ''}</p><table><thead><tr><th>Item / HSN or SAC</th><th>Quantity</th><th>Rate</th><th>Discount</th><th>Tax</th><th>Amount</th></tr></thead><tbody>
 ${doc.lines.map((l) => `<tr><td>${escape(l.description)}<br><small>${escape(l.hsn_sac)}</small></td><td>${Number(l.quantity_milli) / 1000}</td><td>${money(l.rate)}</td><td>${money(l.discount)}</td><td>${Number(l.tax_rate) / 100}%</td><td>${money(Number(l.amount) + Number(l.document_discount || 0))}</td></tr>`).join('')}</tbody></table>
 <p class="right">Subtotal before document discount: ${money(Number(doc.subtotal) + Number(doc.discount_total || 0))}<br>Document discount: ${money(doc.discount_total || 0)}<br>Subtotal: ${money(doc.subtotal)}<br>CGST: ${money(doc.tax_breakup.cgst || 0)}<br>SGST: ${money(doc.tax_breakup.sgst || 0)}<br>IGST: ${money(doc.tax_breakup.igst || 0)}</p>
 <p class="right">${escape(doc.adjustment_description || 'Adjustment')}: ${money(doc.adjustment || 0)}</p>
 <p class="right total">Total: ${money(doc.total)}</p><footer>${escape(doc.notes)}${doc.terms ? '<h3>Terms &amp; Conditions</h3>' + escape(doc.terms) : ''}</footer></body></html>`;
}
module.exports = { printDocument };
