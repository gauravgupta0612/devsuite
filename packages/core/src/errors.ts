/** Error-signature utilities used by BugTrail to recognise the same bug across runs and projects. */

export interface ExtractedError {
  /** e.g. TypeError, NullPointerException, CPF9898, SQL0204 */
  type: string;
  /** First meaningful message line. */
  message: string;
  /** Normalised signature: stable across runs (numbers, paths, ids removed). */
  signature: string;
  /** Top stack frame we could identify, if any. */
  location?: { file: string; line?: number };
  raw: string;
}

const ERROR_LINE = [
  // JS / TS / Python / Java / C# / Go style "SomethingError: message"
  /\b((?:[A-Za-z_][\w$]*\.)*[A-Z][\w$]*(?:Error|Exception|Fault|Failure))\b:?\s*(.*)$/,
  // Python last line "ValueError: x" handled above; Go panics
  /\b(panic):\s*(.+)$/,
  // IBM i message ids
  /\b((?:CPF|CPD|CPA|CPI|MCH|RNX|RNQ|RNF|SQL|CEE|LNR|CZM|CZS|TCP)[0-9A-F]{4})\b[:\s-]*(.*)$/,
  // compilers / test runners
  /\b(error)\s+(TS\d{4}:.*)$/i,
  /^\s*(ERROR|FATAL|FAIL(?:ED)?)\b[:\s]+(.*)$/
];

const STACK_FRAME = [
  /at\s+(?:[^\s(]+\s+\()?((?:[A-Za-z]:)?[^\s():]+\.[a-z]{1,6}):(\d+)(?::\d+)?\)?/, // node
  /File\s+"([^"]+)",\s+line\s+(\d+)/,                                          // python
  /at\s+[\w.$<>]+\(([\w$]+\.(?:java|kt)):(\d+)\)/,                                // java
  /((?:[A-Za-z]:)?[^\s:()]+\.(?:go|cs|ts|tsx|js|py|rb|php|rpgle|sqlrpgle|clle)):(\d+)/ // generic
];

export function normalizeMessage(msg: string): string {
  return msg
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@~-]+)+[\\/]?/g, '<path>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '<time>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/(['"`])(?:(?!\1).){25,}\1/g, '<str>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 220);
}

/** Find the most significant error in a block of output (terminal, debug console, test runner). */
export function extractErrors(output: string, max = 3): ExtractedError[] {
  // Strip ANSI colour codes
  const clean = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
  const lines = clean.split('\n');
  const found: ExtractedError[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l.length > 1000) continue;
    for (const re of ERROR_LINE) {
      const m = re.exec(l);
      if (!m) continue;
      if (/^(at|File)\s/.test(l)) break;
      let type = m[1];
      const message = (m[2] || l).trim();
      if (/^(error|ERROR|FAIL|FAILED|FATAL)$/i.test(type) && !message) break;
      if (/^(error|ERROR)$/.test(type)) type = 'Error';
      let location: ExtractedError['location'];
      for (let j = i + 1; j < Math.min(lines.length, i + 25) && !location; j++) {
        if (/node_modules|internal\/|site-packages|<anonymous>|java\.base/.test(lines[j])) continue;
        for (const fr of STACK_FRAME) { const fm = fr.exec(lines[j]); if (fm) { location = { file: fm[1], line: +fm[2] }; break; } }
      }
      const signature = `${type.split('.').pop()!.toLowerCase()}: ${normalizeMessage(message)}`;
      if (seen.has(signature)) break;
      seen.add(signature);
      found.push({ type: type.split('.').pop()!, message: message.slice(0, 300), signature, location, raw: lines.slice(i, i + 12).join('\n').slice(0, 2000) });
      break;
    }
  }
  // Python tracebacks put the real error last; prefer specific types over generic "Error"/"FAIL"
  found.sort((a, b) => (/^(Error|FAIL|FAILED|FATAL)$/i.test(a.type) ? 1 : 0) - (/^(Error|FAIL|FAILED|FATAL)$/i.test(b.type) ? 1 : 0));
  if (/Traceback \(most recent call last\)/.test(clean)) found.reverse();
  return found.slice(0, max);
}

function tokens(s: string): Set<string> {
  return new Set(s.split(/[^a-z0-9<>_]+/).filter(t => t.length > 1));
}

/** Jaccard similarity of two signatures, boosted when error types match. */
export function signatureSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const j = inter / (ta.size + tb.size - inter);
  const sameType = a.split(':')[0] === b.split(':')[0];
  return Math.min(1, sameType ? j * 1.15 : j * 0.7);
}
