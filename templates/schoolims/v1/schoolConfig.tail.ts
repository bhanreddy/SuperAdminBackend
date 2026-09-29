/** True when a config value is blank or a placeholder like NA / nil. */
function isBlankOfficialConfig(v?: string | null): boolean {
  const t = String(v ?? '').trim();
  if (!t) return true;
  return /^(n\/?a|na|nil|null|none|undefined|-|—|\.{2,}|_{2,})$/i.test(t);
}

/**
 * Combined recognition line for certificates / PDFs.
 * Built from `SCHOOL_CONFIG.recognitionLine` + optional `recognitionNo` (RC No.).
 * Empty when neither is configured — callers must hide the UI, not show "NA".
 */
export const SCHOOL_RECOGNITION_LINE = (() => {
  const line = String(SCHOOL_CONFIG.recognitionLine ?? '').trim();
  const rc = String(SCHOOL_CONFIG.recognitionNo ?? '').trim();
  const hasLine = !isBlankOfficialConfig(line);
  const hasRc = !isBlankOfficialConfig(rc);
  if (!hasLine && !hasRc) return '';
  if (hasLine && hasRc) {
    if (/rc\s*no\.?/i.test(line)) return line;
    return `${line.replace(/\s*,?\s*$/, '')}, RC No. ${rc}`;
  }
  if (hasLine) return line;
  return `RC No. ${rc}`;
})();
