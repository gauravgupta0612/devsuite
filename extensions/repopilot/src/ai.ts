import * as vscode from 'vscode';
import { RepoIndex, SearchHit, languageLabel, searchIndex, snippet } from '@devsuite/core';
import { IndexService } from './indexService';

/** Compact, model-friendly text summary of the index. */
export function overviewText(idx: RepoIndex): string {
  const L: string[] = [];
  L.push(`Repository: ${idx.name} (${idx.files.length} files)`);
  L.push(`Languages: ${idx.languages.filter(l => l.language !== 'other').slice(0, 8).map(l => `${languageLabel(l.language)} ${l.files} files/${l.lines} lines`).join('; ')}`);
  if (idx.frameworks.length) L.push(`Frameworks: ${idx.frameworks.map(f => `${f.name} [${f.evidence[0]?.file}]`).join('; ')}`);
  if (idx.buildSystems.length) L.push(`Build systems: ${idx.buildSystems.map(b => `${b.name} [${b.evidence[0]?.file}]`).join('; ')}`);
  if (idx.buildCommands.length) L.push(`Build commands:\n${idx.buildCommands.slice(0, 20).map(c => `  - ${c.command} (cwd ${c.cwd || '.'}; from ${c.evidence.file}${c.evidence.note ? `: ${c.evidence.note}` : ''})`).join('\n')}`);
  if (idx.entryPoints.length) L.push(`Entry points:\n${idx.entryPoints.slice(0, 15).map(e => `  - ${e.file}: ${e.reason}`).join('\n')}`);
  L.push(`Modules:\n${idx.modules.slice(0, 20).map(m => `  - ${m.name}: ${m.files} files, ${m.lines} lines, ${m.languages.join('/')}${m.dependsOn.length ? `, depends on ${m.dependsOn.slice(0, 6).join(', ')}` : ''}`).join('\n')}`);
  if (idx.hotspots.length) L.push(`Most depended-upon files:\n${idx.hotspots.slice(0, 10).map(h => `  - ${h.file} (${h.dependents} dependents)`).join('\n')}`);
  if (idx.cycles.length) L.push(`Circular dependency groups: ${idx.cycles.length} (largest: ${idx.cycles[0].slice(0, 5).join(' <-> ')})`);
  return L.join('\n');
}

export function dependentsText(service: IndexService, file: string): string {
  const g = service.graph;
  const idx = service.index;
  if (!g || !idx) return 'Index not available.';
  if (!idx.files.some(f => f.path === file)) {
    const guess = idx.files.find(f => f.path.toLowerCase().endsWith(file.toLowerCase()));
    if (!guess) return `File "${file}" is not in the index.`;
    file = guess.path;
  }
  const t = g.transitiveDependents(file);
  const direct = g.dependentsOf(file);
  const deps = g.dependenciesOf(file);
  const L = [`File: ${file}`];
  L.push(`Direct dependents (${direct.length}):\n${direct.map(e => `  - ${e.from}:${e.line} (${e.kind} ${e.specifier})`).join('\n') || '  none'}`);
  const indirect = [...t.entries()].filter(([, d]) => d > 1).sort((a, b) => a[1] - b[1]);
  L.push(`Indirect dependents (${indirect.length}):\n${indirect.slice(0, 60).map(([f, d]) => `  - ${f} (distance ${d})`).join('\n') || '  none'}`);
  const tests = [...t.keys()].filter(f => idx.files.find(x => x.path === f)?.isTest);
  L.push(`Tests that exercise it (${tests.length}):\n${tests.map(f => `  - ${f}`).join('\n') || '  none found'}`);
  L.push(`It depends on (${deps.length}):\n${deps.map(e => `  - ${e.to} (${e.kind})`).join('\n') || '  nothing internal'}`);
  return L.join('\n');
}

export function evidenceContext(idx: RepoIndex, hits: SearchHit[], max = 6): string {
  return hits.slice(0, max).map(h =>
    `--- ${h.file} (${h.reasons.join(', ') || 'content match'}) ---\n${snippet(idx.root, h.file, h.line ?? 1, 60, 5000)}`
  ).join('\n\n');
}

const SYSTEM = `You are RepoPilot, a codebase onboarding assistant inside VS Code.
Answer ONLY from the repository overview and code excerpts provided. Excerpt lines are prefixed with their line numbers.
Cite evidence for every claim as markdown links in the form [path:line](path#Lline).
If the evidence is insufficient, say what is missing and which files to inspect next. Be concise and concrete.`;

export async function pickModel(): Promise<vscode.LanguageModelChat | undefined> {
  if (!vscode.workspace.getConfiguration('repopilot').get<boolean>('useLanguageModel', true)) return undefined;
  if (!(vscode as any).lm?.selectChatModels) return undefined;
  try {
    const preferred = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (preferred.length) return preferred.find(m => /gpt-4o|claude|sonnet/i.test(m.family)) ?? preferred[0];
    const any = await vscode.lm.selectChatModels();
    return any[0];
  } catch {
    return undefined;
  }
}

function buildMessages(idx: RepoIndex, question: string, extra: string): vscode.LanguageModelChatMessage[] {
  return [
    vscode.LanguageModelChatMessage.User(SYSTEM),
    vscode.LanguageModelChatMessage.User(`REPOSITORY OVERVIEW\n${overviewText(idx)}\n\n${extra}\n\nQUESTION: ${question}`)
  ];
}

/** "RepoPilot: Ask About This Codebase" command. */
export async function askCommand(service: IndexService): Promise<void> {
  const idx = await service.ensureIndex();
  if (!idx) return;
  const question = await vscode.window.showInputBox({
    prompt: 'Ask about this codebase',
    placeHolder: 'e.g. Where is authentication handled?  How is an order saved?  Which program prints invoices?'
  });
  if (!question) return;
  const hits = searchIndex(idx, question, 12);
  const model = await pickModel();

  if (!model) {
    if (!hits.length) { vscode.window.showInformationMessage('RepoPilot found no matching files.'); return; }
    const pick = await vscode.window.showQuickPick(
      hits.map(h => ({ label: h.file, description: h.reasons.join(' · '), detail: `score ${h.score.toFixed(1)}${h.line ? ` · line ${h.line}` : ''}`, hit: h })),
      { title: `Most relevant files for “${question}”`, placeHolder: 'No language model available — showing ranked evidence. Pick a file to open.' }
    );
    if (pick) vscode.commands.executeCommand('repopilot.openEvidence', { file: pick.hit.file, line: pick.hit.line });
    return;
  }

  const answer = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `RepoPilot is asking ${model.name}…`, cancellable: true },
    async (_p, token) => {
      const res = await model.sendRequest(buildMessages(idx, question, `CODE EXCERPTS\n${evidenceContext(idx, hits)}`), {}, token);
      let text = '';
      for await (const chunk of res.text) text += chunk;
      return text;
    }
  );
  const base = idx.root.replace(/\\/g, '/');
  const absolutised = answer.replace(/\]\((?!https?:|file:|#)([^)#\s]+)(#L\d+)?\)/g, (_m, p, l) =>
    `](${vscode.Uri.file(`${base}/${p}`).toString()}${l ?? ''})`);
  const sources = hits.slice(0, 6).map(h => `- [${h.file}${h.line ? `:${h.line}` : ''}](${vscode.Uri.file(`${base}/${h.file}`).toString()}${h.line ? `#L${h.line}` : ''}) — ${h.reasons.join(', ') || 'content match'}`).join('\n');
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: `# ${question}\n\n${absolutised}\n\n---\n**Evidence retrieved by RepoPilot**\n\n${sources}\n\n_Answered by ${model.name} from local index of ${idx.name}._\n`
  });
  await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
}

/** @repopilot chat participant. */
export function registerChat(context: vscode.ExtensionContext, service: IndexService): void {
  if (!(vscode as any).chat?.createChatParticipant) return;
  const handler: vscode.ChatRequestHandler = async (request, _ctx, stream, token) => {
    const idx = await service.ensureIndex();
    if (!idx) { stream.markdown('Open a folder first, then run **RepoPilot: Scan Workspace**.'); return; }
    stream.progress('Consulting the RepoPilot index…');
    let extra = '';
    let question = request.prompt;
    let refs: SearchHit[] = [];

    if (request.command === 'overview') {
      question = question || 'Explain the architecture of this project: main modules, how they relate, entry points, and where a new developer should start.';
      refs = idx.hotspots.slice(0, 4).map(h => ({ file: h.file, score: 1, reasons: ['core file'] }))
        .concat(idx.entryPoints.slice(0, 3).map(e => ({ file: e.file, score: 1, reasons: ['entry point'], line: e.evidence.line })));
    } else if (request.command === 'build') {
      question = question || 'How do I install dependencies, build, run and test this project?';
      refs = [...new Set(idx.buildCommands.map(c => c.evidence.file))].slice(0, 4).map(f => ({ file: f, score: 1, reasons: ['build manifest'] }));
      if (idx.readme) refs.unshift({ file: idx.readme, score: 1, reasons: ['README'] });
    } else if (request.command === 'uses') {
      const ed = vscode.window.activeTextEditor;
      const rel = ed && service.relativePath(ed.document.uri);
      if (!rel) { stream.markdown('Open a file from the workspace first.'); return; }
      extra = `IMPACT DATA\n${dependentsText(service, rel)}\n\n`;
      question = question || `What depends on ${rel}, and what could break if I change it?`;
      refs = [{ file: rel, score: 1, reasons: ['active file'] }];
    } else {
      refs = searchIndex(idx, question, 10);
    }
    extra += `CODE EXCERPTS\n${evidenceContext(idx, refs)}`;
    for (const r of refs.slice(0, 6)) {
      const uri = service.uriOf(r.file);
      if (uri) stream.reference(r.line ? new vscode.Location(uri, new vscode.Position(r.line - 1, 0)) : uri);
    }
    try {
      const res = await request.model.sendRequest(buildMessages(idx, question, extra), {}, token);
      for await (const chunk of res.text) stream.markdown(chunk);
    } catch (e: any) {
      stream.markdown(`Language model request failed: ${e?.message ?? e}\n\nMost relevant files:\n`);
      for (const r of refs) stream.markdown(`- \`${r.file}\` — ${r.reasons.join(', ')}\n`);
    }
  };
  const participant = vscode.chat.createChatParticipant('repopilot.chat', handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'logo.png');
  context.subscriptions.push(participant);
}

/** Language-model tools so Copilot agent mode (and other LM clients) can query the index. */
export function registerTools(context: vscode.ExtensionContext, service: IndexService): void {
  if (!(vscode as any).lm?.registerTool) return;
  const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
  context.subscriptions.push(
    vscode.lm.registerTool<Record<string, never>>('repopilot_projectOverview', {
      async invoke() {
        const idx = await service.ensureIndex();
        return text(idx ? overviewText(idx) : 'No workspace folder is open.');
      }
    }),
    vscode.lm.registerTool<{ file: string }>('repopilot_fileDependents', {
      prepareInvocation: o => ({ invocationMessage: `RepoPilot: finding dependents of ${o.input.file}` }),
      async invoke(o) {
        await service.ensureIndex();
        return text(dependentsText(service, o.input.file.replace(/\\/g, '/').replace(/^\.?\//, '')));
      }
    }),
    vscode.lm.registerTool<{ query: string }>('repopilot_searchCode', {
      prepareInvocation: o => ({ invocationMessage: `RepoPilot: searching for “${o.input.query}”` }),
      async invoke(o) {
        const idx = await service.ensureIndex();
        if (!idx) return text('No workspace folder is open.');
        const hits = searchIndex(idx, o.input.query, 10);
        return text(hits.map(h => `${h.file}${h.line ? `:${h.line}` : ''} — ${h.reasons.join(', ') || 'content match'} (score ${h.score.toFixed(1)})`).join('\n') || 'No matches.');
      }
    })
  );
}
