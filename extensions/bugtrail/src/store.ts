import * as fs from 'fs';
import * as path from 'path';
import { ExtractedError, signatureSimilarity } from '@devsuite/core';

export type Source = 'terminal' | 'debug' | 'task' | 'manual';

export interface Occurrence {
  at: string;
  source: Source;
  workspace: string;
  command?: string;
  location?: { file: string; line?: number };
  raw?: string;
}
export interface Attempt { at: string; files: string[] }
export interface Resolution { at: string; how: 'auto' | 'manual'; note?: string; files: string[]; command?: string }
export interface Note { at: string; text: string }

export interface BugEntry {
  id: string;
  signature: string;
  type: string;
  message: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  status: 'open' | 'resolved';
  occurrences: Occurrence[];
  attempts: Attempt[];
  resolution?: Resolution;
  history: Resolution[];
  notes: Note[];
  workspaces: string[];
}

export interface RecordResult {
  entry: BugEntry;
  isNew: boolean;
  /** The entry had been resolved before and is now back. */
  recurred: boolean;
  /** A different but similar bug that was resolved before (with its fix). */
  similarResolved?: BugEntry;
}

const MAX_ENTRIES = 2000;
const now = () => new Date().toISOString();
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export class BugStore {
  entries: BugEntry[] = [];
  constructor(private readonly file: string) { this.load(); }

  load() {
    try { this.entries = JSON.parse(fs.readFileSync(this.file, 'utf8')).entries ?? []; } catch { this.entries = []; }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, MAX_ENTRIES);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }, null, 1));
    fs.renameSync(tmp, this.file);
  }

  find(signature: string): BugEntry | undefined {
    let best: BugEntry | undefined, score = 0;
    for (const e of this.entries) {
      const s = e.signature === signature ? 1 : signatureSimilarity(e.signature, signature);
      if (s > score) { score = s; best = e; }
    }
    return score >= 0.85 ? best : undefined;
  }

  record(err: ExtractedError, occ: Occurrence): RecordResult {
    let entry = this.find(err.signature);
    const isNew = !entry;
    let recurred = false;
    if (!entry) {
      entry = { id: rid(), signature: err.signature, type: err.type, message: err.message, firstSeen: occ.at, lastSeen: occ.at, count: 0, status: 'open', occurrences: [], attempts: [], history: [], notes: [], workspaces: [] };
      this.entries.push(entry);
    } else if (entry.status === 'resolved') {
      recurred = true;
      entry.status = 'open';
      if (entry.resolution) entry.history.push(entry.resolution);
      entry.resolution = undefined;
      entry.attempts = [];
    }
    entry.count++;
    entry.lastSeen = occ.at;
    entry.message = err.message || entry.message;
    if (!entry.workspaces.includes(occ.workspace)) entry.workspaces.push(occ.workspace);
    entry.occurrences.push({ ...occ, location: occ.location ?? err.location, raw: (occ.raw ?? err.raw)?.slice(0, 1500) });
    if (entry.occurrences.length > 20) entry.occurrences = entry.occurrences.slice(-20);

    let similarResolved: BugEntry | undefined;
    if (isNew || recurred) {
      let bestScore = 0;
      for (const e of this.entries) {
        if (e === entry || (!e.resolution && !e.history.length)) continue;
        const s = signatureSimilarity(e.signature, entry.signature);
        if (s >= 0.6 && s > bestScore) { bestScore = s; similarResolved = e; }
      }
    }
    this.save();
    return { entry, isNew, recurred, similarResolved };
  }

  /** Remember files saved while bugs are open in this workspace (the "attempted fixes"). */
  trackEdit(workspace: string, file: string, windowMinutes = 180) {
    const cutoff = Date.now() - windowMinutes * 60_000;
    let changed = false;
    for (const e of this.open(workspace)) {
      if (new Date(e.lastSeen).getTime() < cutoff) continue;
      let a = e.attempts[e.attempts.length - 1];
      if (!a || new Date(a.at).getTime() < new Date(e.lastSeen).getTime()) { a = { at: now(), files: [] }; e.attempts.push(a); if (e.attempts.length > 30) e.attempts.shift(); }
      if (!a.files.includes(file)) { a.files.push(file); changed = true; }
    }
    if (changed) this.save();
  }

  resolve(id: string, how: 'auto' | 'manual', note?: string, command?: string): BugEntry | undefined {
    const e = this.entries.find(x => x.id === id);
    if (!e) return undefined;
    const files = [...new Set(e.attempts.flatMap(a => a.files))];
    e.status = 'resolved';
    e.resolution = { at: now(), how, note, files, command };
    this.save();
    return e;
  }

  /** Auto-resolve open entries whose failing command/task/config just succeeded. */
  resolveBySuccess(workspace: string, source: Source, command: string): BugEntry[] {
    const done: BugEntry[] = [];
    for (const e of this.open(workspace)) {
      const last = e.occurrences[e.occurrences.length - 1];
      if (last && last.source === source && last.command === command) {
        this.resolve(e.id, 'auto', undefined, command);
        done.push(e);
      }
    }
    return done;
  }

  addNote(id: string, text: string) {
    const e = this.entries.find(x => x.id === id);
    if (!e) return;
    e.notes.push({ at: now(), text });
    if (e.resolution && !e.resolution.note) e.resolution.note = text;
    this.save();
  }

  remove(id: string) { this.entries = this.entries.filter(e => e.id !== id); this.save(); }
  clear() { this.entries = []; this.save(); }

  open(workspace?: string) { return this.entries.filter(e => e.status === 'open' && (!workspace || e.workspaces.includes(workspace))); }

  search(query: string, limit = 30): { entry: BugEntry; score: number }[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.entries.slice().sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, limit).map(entry => ({ entry, score: 1 }));
    const terms = q.split(/\s+/).filter(Boolean);
    return this.entries.map(entry => {
      const hay = [entry.type, entry.message, entry.signature, ...entry.notes.map(n => n.text), entry.resolution?.note ?? '', ...entry.occurrences.map(o => `${o.command ?? ''} ${o.location?.file ?? ''}`), ...(entry.resolution?.files ?? [])].join(' ').toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += entry.type.toLowerCase() === t ? 3 : 1;
      score += signatureSimilarity(entry.signature, q) * 2;
      return { entry, score };
    }).filter(x => x.score > 0.4).sort((a, b) => b.score - a.score || b.entry.lastSeen.localeCompare(a.entry.lastSeen)).slice(0, limit);
  }

  toMarkdown(e: BugEntry): string {
    const L = [`# ${e.type}: ${e.message}`, '', `**Status:** ${e.status === 'open' ? '🔴 open' : '✅ resolved'} · seen **${e.count}×** · first ${new Date(e.firstSeen).toLocaleString()} · last ${new Date(e.lastSeen).toLocaleString()}`, ''];
    if (e.resolution) {
      L.push('## How it was fixed', '', `- ${new Date(e.resolution.at).toLocaleString()} — ${e.resolution.how === 'auto' ? `automatically, when \`${e.resolution.command ?? 'the run'}\` succeeded` : 'marked fixed manually'}`);
      if (e.resolution.note) L.push(`- Note: ${e.resolution.note}`);
      if (e.resolution.files.length) L.push(`- Files changed: ${e.resolution.files.map(f => `\`${f}\``).join(', ')}`);
      L.push('');
    }
    if (e.history.length) { L.push('## Earlier fixes', ''); for (const h of e.history.slice(-5).reverse()) L.push(`- ${new Date(h.at).toLocaleDateString()}: ${h.note ?? 'no note'}${h.files.length ? ` (${h.files.join(', ')})` : ''}`); L.push(''); }
    if (e.attempts.length) { L.push('## Attempts', ''); for (const a of e.attempts) L.push(`- ${new Date(a.at).toLocaleString()}: edited ${a.files.map(f => `\`${f}\``).join(', ')}`); L.push(''); }
    if (e.notes.length) { L.push('## Notes', ''); for (const n of e.notes) L.push(`- ${new Date(n.at).toLocaleString()}: ${n.text}`); L.push(''); }
    L.push('## Occurrences', '');
    for (const o of e.occurrences.slice().reverse().slice(0, 10)) L.push(`- ${new Date(o.at).toLocaleString()} · ${o.source}${o.command ? ` · \`${o.command}\`` : ''}${o.location ? ` · ${o.location.file}${o.location.line ? ':' + o.location.line : ''}` : ''} · ${path.basename(o.workspace)}`);
    const raw = e.occurrences[e.occurrences.length - 1]?.raw;
    if (raw) L.push('', '```', raw, '```');
    L.push('', `<sub>signature: \`${e.signature}\`</sub>`);
    return L.join('\n');
  }
}
