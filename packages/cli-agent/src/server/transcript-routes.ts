import { agentKey, ids, type AgentRenderContext } from "@agents-in-the-cloud/agent/server/render-context";
import { renderReadOnlyTranscript, renderReadOnlyTranscriptDetail } from "@agents-in-the-cloud/agent/server/read-only-transcript";
import { subscribeWorkspaceAgentBusy } from "@agents-in-the-cloud/agent/server";
import { renderWorkspaceCompletionCatalog } from "@agents-in-the-cloud/agent/server/completion-catalog";
import { activityButtonHtml } from "@agents-in-the-cloud/design-system/activity-button";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { renderFollowLatestButton } from "@agents-in-the-cloud/prompt/server";
import { domId, escapeHtml, turboStream, type CableChannelAdapter } from "@agents-in-the-cloud/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { response } from "@agents-in-the-cloud/shared/http";
import type { CliAgentAdapter } from "./adapter.ts";
import type { CliAgents } from "./agents.ts";

type CliTranscriptContext = AgentRenderContext & { transcriptBasePath: string };
function context(workspaceId: string, agentId: string, providerId: string): CliTranscriptContext {
  return { workspaceId, agentId, transcriptBasePath: `/workspaces/${encodeURIComponent(workspaceId)}/${providerId}-agents/${encodeURIComponent(agentId)}/transcript` };
}

/** Available: the transcript can stand in for the terminal. Never mid-turn, and only once there is something to read. */
function renderTranscriptContent(ctx: CliTranscriptContext, available: boolean, html = ""): string {
  return `<div id="${ids.transcript(ctx)}" class="agent-transcript-content" data-cli-terminal-target="transcriptContent" data-available="${available}">${html}</div>`;
}

export function renderCliTranscriptView(adapter: CliAgentAdapter, workspaceId: string, agentId: string): string {
  if (!adapter.loadTranscript) return "";
  return `<div class="agent-transcript cli-transcript-view" tabindex="0" role="region" aria-label="Agent transcript" data-cli-terminal-target="transcript" data-action="scroll->cli-terminal#transcriptScrolled">${renderTranscriptContent(context(workspaceId, agentId, adapter.id), false)}</div>`;
}

export function cliTranscriptAttributes(adapter: CliAgentAdapter, agentId: string): string {
  if (!adapter.loadTranscript) return "";
  return `data-cli-terminal-agent-id-value="${escapeHtml(agentId)}" data-cli-terminal-transcript-channel-value="${escapeHtml(cliTranscriptChannelName(adapter))}"`;
}

/** The composer's slash command catalog; turns can add prompt templates, so each finished turn refreshes it. */
export function cliCompletionCatalogId(workspaceId: string, agentId: string): string { return domId("cli_catalog", workspaceId, agentId); }

/** Where the send/stop button lives in a CLI composer's form; turn boundaries swap its content in place. */
export function cliAgentActionsId(workspaceId: string, agentId: string): string { return domId("cli_actions", workspaceId, agentId); }

const sendIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m-4 4 4-4 4 4"/></svg>';
const stopIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/></svg>';

/**
 * The CLI composer's one button: send while the agent waits, stop while it works.
 * Stopping is Escape to the CLI's own TUI, which cancels its running turn in place,
 * so no terminal process is ever touched. State swaps arrive over the transcript channel.
 */
export function renderCliAgentActions(workspaceId: string, agentId: string, busy: boolean): string {
  const label = busy ? "Agent is working — click to stop" : "Send prompt";
  return `<span class="composer-primary-action" id="${cliAgentActionsId(workspaceId, agentId)}">${activityButtonHtml({
    variant: "primary",
    iconOnly: true,
    initialLabel: label,
    activeLabel: label,
    type: "submit",
    state: busy ? "active" : "initial",
    initialContent: { kind: "html", html: sendIcon },
    activeContent: { kind: "html", html: stopIcon },
    // Busy submits the hidden escape form (the builtin agent's abort pattern); idle submits the composer.
    attributesHtml: busy ? `data-popular-button form="${cliEscapeFormId(workspaceId, agentId)}"` : "data-popular-button",
  })}</span>`;
}

/** The stop button submits here; a native form cannot nest inside the composer's own. */
export function cliEscapeFormId(workspaceId: string, agentId: string): string {
  return domId("cli_escape_form", workspaceId, agentId);
}

export function renderCliEscapeForm(workspaceId: string, agentId: string, url: string): string {
  return `<form id="${cliEscapeFormId(workspaceId, agentId)}" method="post" action="${escapeHtml(url)}"></form>`;
}

function cliTranscriptChannelName(adapter: CliAgentAdapter): string { return `${adapter.id}-transcript`; }

/** Publishes whether the transcript is available whenever the CLI starts or finishes a turn, with the transcript itself for panes showing it, the send/stop button swap, and the refreshed completion catalog between turns. The busy set is shared so tab renders read the same state. */
export function cliTranscriptChannel(adapter: CliAgentAdapter, agents: Pick<CliAgents, "ready" | "terminalState">, busy: Set<string>): CableChannelAdapter {
  // Agent keys identify Agents, which are unique across workspaces.
  const watchers = new Set<{ agentKey: string; changed(): void }>();
  subscribeWorkspaceAgentBusy(({ agentKey, busy: started }) => {
    if (started) busy.add(agentKey); else busy.delete(agentKey);
    for (const watcher of watchers) if (watcher.agentKey === agentKey) watcher.changed();
  });
  async function render(workspaceId: string, agentId: string, includeTranscript: boolean): Promise<string> {
    // The transcript is only shown between turns, so every turn in it has finished.
    const idle = !busy.has(agentKey(agentId));
    const [records, catalog] = idle ? await Promise.all([adapter.loadTranscript!(workspaceId, agentId), renderWorkspaceCompletionCatalog(workspaceId, "cli")]) : [];
    const available = records?.some((record) => record.kind === "user") ?? false;
    const ctx = context(workspaceId, agentId, adapter.id);
    const transcript = turboStream("replace", ids.transcript(ctx), renderTranscriptContent(ctx, available, includeTranscript && available ? renderReadOnlyTranscript(ctx, records!) : ""));
    // The composer only exists under a live terminal; swap its button with the rest of the turn boundary.
    const session = await agents.ready(workspaceId, agentId);
    const running = (await agents.terminalState(workspaceId, session)).state === "running";
    let html = transcript;
    if (running) html += turboStream("replace", cliAgentActionsId(workspaceId, agentId), renderCliAgentActions(workspaceId, agentId, !idle));
    return catalog === undefined ? html : `${html}${turboStream("update", cliCompletionCatalogId(workspaceId, agentId), catalog)}`;
  }
  return {
    name: cliTranscriptChannelName(adapter),
    async subscribe(identifier, listener) {
      if (identifier.channel !== "module" || identifier.name !== cliTranscriptChannelName(adapter)) throw new Error(`Invalid ${adapter.label} transcript channel`);
      const { agentId, transcript } = Value.Parse(Type.Object({ agentId: Type.String({ minLength: 1 }), transcript: Type.Optional(Type.Literal("shown")) }, { additionalProperties: false }), identifier.params);
      const workspaceId = identifier.workspaceId;
      await agents.ready(workspaceId, agentId);
      const publish = async () => listener(await render(workspaceId, agentId, transcript !== undefined));
      // Turn boundaries can arrive while the transcript loads; publish each in order.
      let latest = publish();
      const watcher = {
        agentKey: agentKey(agentId),
        changed() {
          latest = latest.then(publish).catch((error) => {
            console.error(`Could not publish ${adapter.label} transcript for ${agentId}`, error);
          });
        },
      };
      watchers.add(watcher);
      try { await latest; } catch (error) { watchers.delete(watcher); throw error; }
      return { unsubscribe: () => { watchers.delete(watcher); } };
    },
  };
}

/** The view switch (terminal ↔ transcript), ESC key, and the transcript's follow latest, for the floating stack. */
interface CliTranscriptControls { viewSwitch?: string; followLatest?: string; escapeKey?: string }

export function renderCliTranscriptControls(adapter: CliAgentAdapter): CliTranscriptControls {
  if (!adapter.loadTranscript) return {};
  return {
    // Desktop has no key bar (that is soft-keyboard-only), so this carries Escape to the terminal there.
    escapeKey: buttonHtml({
      type: "button", variant: "secondary", content: { kind: "caption", caption: "Esc" },
      attributesHtml: `data-popular-button data-escape-key-button title="Abort-Cancel" data-action="cli-terminal#sendEscapeKey" aria-label="Abort-Cancel"`,
    }),
    viewSwitch: [
      { iconHtml: Icons.Transcript, label: "View transcript", state: "transcript", action: "showTranscript" },
      { iconHtml: Icons.Terminal, label: "Back to terminal", state: "terminal", action: "showTerminal" },
      { iconHtml: Icons.TranscriptPending, label: "Will autoswitch to transcript when agent is done", state: "pending", action: "showTerminal" },
    ].map(({ iconHtml, label, state, action }) => buttonHtml({
      type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml, label },
      attributesHtml: `data-popular-button data-cli-transcript-button="${state}" data-action="cli-terminal#${action}" aria-keyshortcuts="Meta+Alt+P"`,
    })).join(""),
    followLatest: renderFollowLatestButton('data-cli-terminal-target="transcriptEnd" data-action="cli-terminal#scrollToTranscriptEnd"'),
  };
}

export function cliTranscriptRoutes(adapter: CliAgentAdapter, agents: CliAgents) {
  return async (request: Request, url: URL): Promise<Response | undefined> => {
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/([^/]+)-agents\/([^/]+)\/transcript\/(transcript-items|session-images)\/([^/]+)(?:\/(\d+))?$/);
    if (!match || match[2] !== adapter.id || request.method !== "GET" || !adapter.loadTranscript) return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const agentId = decodeURIComponent(match[3]!);
    await agents.ready(workspaceId, agentId);
    const ctx = context(workspaceId, agentId, adapter.id);
    if (match[4] === "session-images") {
      if (!adapter.loadTranscriptImage || match[6] === undefined) return new Response("Not found", { status: 404 });
      return adapter.loadTranscriptImage(workspaceId, agentId, decodeURIComponent(match[5]!), Number(match[6]));
    }
    const records = await adapter.loadTranscript(workspaceId, agentId);
    const count = Math.max(100, Math.min(100_000, Number(url.searchParams.get("count") ?? 100) || 100));
    const html = records && renderReadOnlyTranscriptDetail(ctx, records, decodeURIComponent(match[5]!), count);
    return response(html ?? "Not found", { status: html ? 200 : 404 });
  };
}
