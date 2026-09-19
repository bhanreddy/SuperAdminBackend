const { defaultLogoDataUri } = require('./brandLogo');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function date(value) {
  if (!value) return '—';
  const raw = String(value).slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T12:00:00+05:30`)
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

function safeDataImage(value) {
  const image = String(value || '').trim();
  if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) return '';
  return image;
}

const TITLES = {
  PAYSLIP: 'Salary Payslip',
  EMPLOYMENT_CERTIFICATE: 'Employment Certificate',
  EXPERIENCE_CERTIFICATE: 'Experience Certificate',
  INTERNSHIP_CERTIFICATE: 'Internship Certificate',
  OFFER_LETTER: 'Offer Letter',
  RELIEVING_LETTER: 'Relieving Letter',
};

function certificateBody(type, employee, payload, orgName) {
  const name = `<strong>${escapeHtml(employee.full_name)}</strong>`;
  const role = `<strong>${escapeHtml(employee.designation)}</strong>`;
  const joined = date(payload.start_date || employee.joining_date);
  const ended = date(payload.end_date || employee.exit_date || new Date());
  if (type === 'EMPLOYMENT_CERTIFICATE') return `This is to certify that ${name}, employee ID <strong>${escapeHtml(employee.employee_code)}</strong>, is employed with ${escapeHtml(orgName)} as ${role} in the ${escapeHtml(employee.department)} department since ${joined}. This certificate is issued upon the employee's request for official purposes.`;
  if (type === 'EXPERIENCE_CERTIFICATE') return `This is to certify that ${name} was employed with ${escapeHtml(orgName)} as ${role} in the ${escapeHtml(employee.department)} department from ${joined} to ${ended}. During this tenure, their conduct and contribution were found to be professional and valuable. We wish them success in their future endeavours.`;
  if (type === 'INTERNSHIP_CERTIFICATE') return `This is to certify that ${name} successfully completed an internship with ${escapeHtml(orgName)} as ${role} in the ${escapeHtml(employee.department)} department from ${joined} to ${ended}. During the internship, they demonstrated sincerity, initiative and a strong willingness to learn.`;
  if (type === 'RELIEVING_LETTER') return `This letter confirms that ${name}, formerly ${role} in the ${escapeHtml(employee.department)} department, has been relieved from duties at ${escapeHtml(orgName)} effective ${ended}. We confirm that the formal handover has been completed and wish them the very best.`;
  return `We are pleased to offer ${name} the position of ${role} in the ${escapeHtml(employee.department)} department at ${escapeHtml(orgName)}, commencing on ${joined}. Your monthly gross compensation will be <strong>${money(Number(employee.basic_salary) + Number(employee.hra) + Number(employee.allowances))}</strong>, subject to company policy and statutory deductions.`;
}

const DOCUMENT_CSS = `
@page { size: A4; margin: 0 }
* { box-sizing: border-box }
body { margin: 0; background: #eef0f7; font-family: Inter, Arial, sans-serif; color: #171827 }
.page {
  width: 210mm; min-height: 297mm; margin: auto; background: #fff;
  padding: 18mm 17mm 28mm; position: relative; overflow: hidden;
}
.bar {
  height: 7px; background: linear-gradient(90deg, #7c3aed, #2563eb, #06b6d4);
  position: absolute; left: 0; right: 0; top: 0; z-index: 3;
}
.wm { position: absolute; inset: 0; pointer-events: none; user-select: none; overflow: hidden; z-index: 0 }
.wm-logo {
  position: absolute; top: 46%; left: 50%; width: 70%; max-width: 480px;
  transform: translate(-50%, -50%) rotate(-18deg);
  opacity: 0.13; mix-blend-mode: multiply;
}
.wm-word {
  position: absolute; top: 54%; left: 50%;
  transform: translate(-50%, -50%) rotate(-18deg);
  font-size: 58px; font-weight: 800; letter-spacing: 12px; text-transform: uppercase;
  color: rgba(109, 40, 217, 0.09); white-space: nowrap;
}
.wm-orb {
  position: absolute; right: -40px; bottom: 58px; width: 210px; height: 210px;
  border-radius: 50%; background: radial-gradient(circle, rgba(124, 58, 237, 0.08), transparent 70%);
}
.head, .title, .grid, .salary, .net, .body, .sign, .verify, .foot { position: relative; z-index: 1 }
.head { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e7e8ef; padding-bottom: 18px }
.brand { display: flex; align-items: center; gap: 13px }
.logo { width: 48px; height: 48px; object-fit: contain }
.org { font-size: 22px; font-weight: 800 }
.muted { color: #6b7280; font-size: 12px }
.badge { padding: 7px 11px; border-radius: 999px; background: #f0ebff; color: #6d28d9; font-size: 11px; font-weight: 800; letter-spacing: .08em }
.title { text-align: center; margin: 32px 0 26px }
.title h1 { font-size: 27px; margin: 0 0 7px }
.title p { margin: 0; color: #6b7280; font-size: 12px }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 34px; padding: 16px; background: #f8f8fc; border-radius: 12px }
.field { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid #ebeaf2; font-size: 12px }
.field b { text-align: right }
.salary { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 22px }
.box { border: 1px solid #e6e5ee; border-radius: 12px; overflow: hidden }
.box h3 { margin: 0; padding: 12px 14px; background: #f7f6fb; font-size: 13px }
.row { display: flex; justify-content: space-between; padding: 10px 14px; font-size: 12px; border-top: 1px solid #efeff4 }
.total { font-weight: 800; background: #fafafa }
.net { margin-top: 20px; padding: 18px; border-radius: 13px; background: linear-gradient(135deg, #24114f, #4f46e5); color: #fff; display: flex; justify-content: space-between; align-items: center }
.net span { font-size: 12px; opacity: .75 }
.net b { font-size: 24px }
.body { font-family: Georgia, serif; font-size: 16px; line-height: 2; margin: 42px 9px 0; text-align: justify }
.sign { margin-top: 56px; display: flex; justify-content: flex-end }
.sign-block { width: 230px; text-align: center; font-size: 12px }
.sign-img { max-width: 190px; max-height: 72px; height: auto; object-fit: contain; display: block; margin: 0 auto 6px }
.sign-space { height: 72px }
.sign-line { border-top: 1px solid #222; padding-top: 9px }
.verify { margin-top: 32px; padding: 12px 14px; border: 1px solid #dcd4ff; border-radius: 10px; background: #faf8ff; font-size: 10px; color: #5b5870 }
.verify strong { display: block; color: #4c1d95; margin-bottom: 5px }
.verify a { color: #6d28d9; text-decoration: none; overflow-wrap: anywhere }
.foot { position: absolute; bottom: 15mm; left: 17mm; right: 17mm; border-top: 1px solid #e7e8ef; padding-top: 10px; display: flex; justify-content: space-between; color: #858796; font-size: 10px }
@media print { body { background: #fff } .page { margin: 0 } }
`;

function renderEmployeeDocumentHtml({ document, employee, payroll, config, verificationUrl }) {
  const type = document.document_type;
  const payload = document.payload || {};
  const orgName = config?.organisation_name || 'NexSyrus';
  const title = TITLES[type] || document.title;
  const logo = defaultLogoDataUri();
  const signature = safeDataImage(config?.authorised_signatory_image);
  const isPayslip = type === 'PAYSLIP';
  const monthName = payroll ? new Date(payroll.payroll_year, payroll.payroll_month - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) : '';
  const earnings = payroll ? [
    ['Basic salary', payroll.basic_pay], ['House rent allowance', payroll.hra_pay], ['Other allowances', payroll.allowance_pay],
  ] : [];
  const deductions = payroll ? [
    ['Provident fund', payroll.pf_deduction], ['ESI', payroll.esi_deduction], ['Other deductions', payroll.other_deductions],
  ] : [];
  const payslipBody = isPayslip ? `<section class="grid"><div class="field"><span>Employee</span><b>${escapeHtml(employee.full_name)}</b></div><div class="field"><span>Employee ID</span><b>${escapeHtml(employee.employee_code)}</b></div><div class="field"><span>Designation</span><b>${escapeHtml(employee.designation)}</b></div><div class="field"><span>Department</span><b>${escapeHtml(employee.department)}</b></div><div class="field"><span>Paid days</span><b>${escapeHtml(payroll.paid_days)} / ${escapeHtml(payroll.working_days)}</b></div><div class="field"><span>Bank a/c</span><b>${employee.bank_account_number ? `•••• ${escapeHtml(String(employee.bank_account_number).slice(-4))}` : '—'}</b></div></section><section class="salary"><div class="box"><h3>Earnings</h3>${earnings.map(([l, v]) => `<div class="row"><span>${l}</span><b>${money(v)}</b></div>`).join('')}<div class="row total"><span>Gross pay</span><b>${money(payroll.gross_pay)}</b></div></div><div class="box"><h3>Deductions</h3>${deductions.map(([l, v]) => `<div class="row"><span>${l}</span><b>${money(v)}</b></div>`).join('')}<div class="row total"><span>Total deductions</span><b>${money(payroll.total_deductions)}</b></div></div></section><section class="net"><div><span>NET SALARY</span><div>Paid for ${escapeHtml(monthName)}</div></div><b>${money(payroll.net_pay)}</b></section>` : '';
  const certificateSection = isPayslip ? '' : `<section class="body">${certificateBody(type, employee, payload, orgName)}</section>
  <section class="sign"><div class="sign-block">${signature ? `<img class="sign-img" src="${signature}" alt="Authorised signature">` : '<div class="sign-space"></div>'}<div class="sign-line"><strong>${escapeHtml(config?.authorised_signatory || 'Authorised Signatory')}</strong><br>${escapeHtml(config?.authorised_signatory_title || 'Founder & CEO')}<br>${escapeHtml(orgName)}</div></div></section>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(document.document_number)}</title>
  <style>${DOCUMENT_CSS}</style></head>
  <body><main class="page">
  <div class="bar"></div>
  <div class="wm" aria-hidden="true">
    ${logo ? `<img class="wm-logo" src="${escapeHtml(logo)}" alt="">` : ''}
    <div class="wm-word">${escapeHtml(orgName)}</div>
    <div class="wm-orb"></div>
  </div>
  <header class="head"><div class="brand">${logo ? `<img class="logo" src="${escapeHtml(logo)}" alt="">` : ''}<div><div class="org">${escapeHtml(orgName)}</div><div class="muted">${escapeHtml(config?.organisation_address || 'Official HR Document')}</div></div></div><div class="badge">VERIFIED</div></header>
  <section class="title"><h1>${escapeHtml(title)}</h1><p>${isPayslip ? `Pay period · ${escapeHtml(monthName)}` : `Issued on ${date(document.generated_at)}`} · ${escapeHtml(document.document_number)}</p></section>
  ${payslipBody}${certificateSection}
  ${verificationUrl ? `<section class="verify"><strong>Verify this document online</strong><a href="${escapeHtml(verificationUrl)}">${escapeHtml(verificationUrl)}</a></section>` : ''}
  <footer class="foot"><span>Computer-generated, independently verifiable HR document</span><span>${escapeHtml(document.document_number)}</span></footer>
  </main><script>window.addEventListener('load',()=>{document.title='${escapeHtml(document.document_number)}';});</script></body></html>`;
}

function renderVerificationHtml(record) {
  const valid = Boolean(record);
  const title = valid ? 'Document verified' : 'Verification failed';
  const tone = valid ? '#10b981' : '#ef4444';
  const fields = valid ? [
    ['Document', TITLES[record.document_type] || record.title],
    ['Document number', record.document_number],
    ['Employee', record.full_name],
    ['Employee ID', record.employee_code],
    ['Designation', record.designation],
    ['Department', record.department],
    ['Issued on', date(record.generated_at)],
  ] : [];
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · NexSyrus</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:22px;background:radial-gradient(circle at top,#302151,#11101a 58%);font-family:Inter,Arial,sans-serif;color:#f8f7ff}.card{width:min(100%,620px);border:1px solid #ffffff1a;border-radius:26px;padding:30px;background:#1c1928e8;box-shadow:0 30px 80px #0008}.mark{width:64px;height:64px;border-radius:20px;display:grid;place-items:center;background:${tone}20;color:${tone};font-size:31px;font-weight:900}.eyebrow{margin-top:22px;color:${tone};font-size:11px;font-weight:900;letter-spacing:.13em}.title{font-size:32px;margin:8px 0 8px}.sub{color:#aaa6bb;font-size:14px;line-height:1.6}.details{margin-top:25px;border:1px solid #ffffff10;border-radius:16px;overflow:hidden}.row{display:flex;justify-content:space-between;gap:25px;padding:13px 15px;border-top:1px solid #ffffff10}.row:first-child{border-top:0}.label{color:#918ca2;font-size:12px}.value{text-align:right;font-size:12px;font-weight:700}.foot{margin-top:23px;color:#787386;font-size:11px;line-height:1.6}@media(max-width:500px){.card{padding:22px}.title{font-size:26px}.row{display:block}.value{text-align:left;margin-top:5px}}</style></head><body><main class="card"><div class="mark">${valid ? '✓' : '!'}</div><div class="eyebrow">NEXSYRUS DOCUMENT VERIFICATION</div><h1 class="title">${title}</h1><p class="sub">${valid ? 'This document exists in the NexSyrus HR document registry and its identifying details match our official record.' : 'This verification link is invalid or the document does not exist in the NexSyrus HR document registry.'}</p>${valid ? `<section class="details">${fields.map(([label, value]) => `<div class="row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`).join('')}</section>` : ''}<p class="foot">For privacy, salary, bank and statutory deduction information is never shown on this public verification page.</p></main></body></html>`;
}

module.exports = { renderEmployeeDocumentHtml, renderVerificationHtml, TITLES };
