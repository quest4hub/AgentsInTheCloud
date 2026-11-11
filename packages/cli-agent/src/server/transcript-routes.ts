import { agentKey, ids, type AgentRenderContext } from "@agents-in-the-cloud/agent/server/render-context";
import { renderReadOnlyTranscript, renderReadOnlyTranscriptDetail } from "@agents-in-the-cloud/agent/server/read-only-transcript";
import { subscribeWorkspaceAgentBusy, publishWorkspaceAgentBusy } from "@agents-in-the-cloud/agent/server";
import { renderWorkspaceCompletionCatalog } from "@agents-in-the-cloud/agent/server/completion-catalog";
import { activityButtonHtml } from "@agents-in-the-cloud/design-system/activity-button";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { renderFollowLatestButton } from "@agents-in-the-cloud/prompt/server";
import { domId, escapeHtml, turboStream, turboStreamResponse, type CableChannelAdapter } from "@agents-in-the-cloud/shared";
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

function cliTranscriptChannelName(adapter: CliAgentAdapter): string { return `${adapter.id}-transcript`; }

/** Publishes whether the transcript is available whenever the CLI starts or finishes a turn, with the transcript itself for panes showing it, and the refreshed completion catalog between turns. */
export function cliTranscriptChannel(adapter: CliAgentAdapter, agents: Pick<CliAgents, "ready">): CableChannelAdapter {
  // Agent keys identify Agents, which are unique across workspaces.
  const busy = new Set<string>();
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
    return catalog === undefined ? transcript : `${transcript}${turboStream("update", cliCompletionCatalogId(workspaceId, agentId), catalog)}`;
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

/** Render the composer actions (send/stop button) for CLI agents. */
export function renderCliAgentComposerActions(workspaceId: string, agentId: string, providerId: string): string {
  const abortFormId = `cli_agent_abort_${workspaceId}_${agentId}`;
  const abortAction = `/workspaces/${encodeURIComponent(workspaceId)}/${providerId}-agents/${encodeURIComponent(agentId)}/abort`;
  const initialLabel = "Send prompt";
  const activeLabel = "Agent is working — click to stop";
  return `<form id="${abortFormId}" method="post" action="${escapeHtml(abortAction)}" hidden></form>
    <span class="composer-primary-action" data-cli-terminal-target="sendStop" data-agent-busy="false" data-agent-stoppable="true" data-agent-abort-form-id="${abortFormId}">${activityButtonHtml({
      variant: "primary",
      iconOnly: true,
      initialLabel,
      activeLabel,
      type: "submit",
      state: "initial",
      initialContent: { kind: "html", html: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m-4 4 4-4 4 4"/></svg>' },
      activeContent: { kind: "html", html: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/></svg>' },
      attributesHtml: `data-popular-button form="${abortFormId}"`,
    })}</span>`;
}

/** The view switch (terminal ↔ transcript), ESC key, and the transcript's follow latest, for the floating stack. */
interface CliTranscriptControls { viewSwitch?: string; followLatest?: string; escapeKey?: string }

export function renderCliTranscriptControls(adapter: CliAgentAdapter): CliTranscriptControls {
  if (!adapter.loadTranscript) return {};
  return {
    escapeKey: buttonHtml({
      type: "button", variant: "secondary", content: { kind: "caption", caption: "Esc" },
      attributesHtml: `data-popular-button data-action="cli-terminal#sendEscapeKey" aria-label="Send Escape key to terminal"`,
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

/** Abort route for CLI agents: stops the terminal process. */
export async function handleCliAbortRequest(adapter: CliAgentAdapter, agents: CliAgents, request: Request, url: URL): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/([^/]+)-agents\/([^/]+)\/abort$/);
  if (!match || match[2] !== adapter.id || request.method !== "POST") return undefined;
  const workspaceId = decodeURIComponent(match[1]!);
  const agentId = decodeURIComponent(match[3]!);
  const session = await agents.ready(workspaceId, agentId);
  // Stop the terminal process.
  const terminalProcesses = (await import("@agents-in-the-cloud/workspace")).workspaceTerminalProcesses;
  await terminalProcesses(workspaceId).release(agentId);
  // Publish busy state change.
  publishWorkspaceAgentBusy({ workspaceId, agentKey: agentKey(agentId), busy: false });
  await agents.settleTurn(workspaceId, agentId, new AbortController().signal, "stop");
  return request.headers.get("accept")?.includes("application/json")
    ? Response.json({ agent: { agentId, state: "idle", aborted: true } })
    : turboStreamResponse("");
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
