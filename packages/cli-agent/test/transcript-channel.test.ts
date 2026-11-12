import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { workspaceWorkHostPath } from "@agents-in-the-cloud/workspace";
import { createAgentsInTheCloudEventBus } from "@agents-in-the-cloud/core";
import { publishWorkspaceAgentBusy } from "../../agent/src/server/workspace-agent-busy.ts";
import type { CliAgentAdapter } from "../src/server/adapter.ts";
import type { CliAgents } from "../src/server/agents.ts";
import { cliAgentActionsId, cliCompletionCatalogId, cliEscapeFormId, cliTranscriptChannel } from "../src/server/transcript-routes.ts";

function fixture(loadTranscript: NonNullable<CliAgentAdapter["loadTranscript"]>, workspaceId = "workspace") {
  const agentId = crypto.randomUUID();
  const adapter: CliAgentAdapter = {
    id: "review", label: "Review", iconHtml: "",
    requireSetup: async () => {},
    settings: { renderFooter: async () => "", prepare: async () => ({}) },
    prepareSession: async () => ({}),
    launchScript: () => "true",
    loadTranscript,
  };
  const agents: Pick<CliAgents, "ready" | "terminalState"> = {
    ready: async () => ({ id: agentId, title: "Review", tmuxSession: `review-${agentId}`, input: { text: "", images: [], attachmentNotes: [] } }),
    terminalState: async () => ({ state: "running", interactive: true }),
  };
  const busy = new Set<string>();
  return {
    agentId,
    channel: cliTranscriptChannel(adapter, agents, busy),
    identifier: { channel: "module" as const, name: "review-transcript", workspaceId, params: { agentId } },
    finishTurn() {
      publishWorkspaceAgentBusy({ workspaceId, agentKey: `agent:${agentId}`, busy: false });
    },
  };
}

test("a failed incremental history read is reported and queued publications continue", async () => {
  const failedRead = Promise.withResolvers<undefined>();
  const recovered = Promise.withResolvers<void>();
  const failure = new Error("history read failed");
  let reads = 0;
  const f = fixture(async () => {
    reads++;
    if (reads === 2) return failedRead.promise;
    return undefined;
  });
  const report = spyOn(console, "error").mockImplementation(() => {});
  let publications = 0;
  const subscription = await f.channel.subscribe(f.identifier, () => {
    publications++;
    if (publications === 2) recovered.resolve();
  }, createAgentsInTheCloudEventBus());
  try {
    f.finishTurn();
    f.finishTurn();
    failedRead.reject(failure);
    await recovered.promise;
    expect(reads).toBe(3);
    expect(publications).toBe(2);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(`Could not publish Review transcript for ${f.agentId}`, failure);
  } finally {
    subscription.unsubscribe();
    report.mockRestore();
  }
});

test("an initial history read failure still rejects channel subscription", async () => {
  const failure = new Error("initial history read failed");
  let reads = 0;
  const f = fixture(async () => { reads++; throw failure; });
  await expect(f.channel.subscribe(f.identifier, () => {}, createAgentsInTheCloudEventBus())).rejects.toBe(failure);
  f.finishTurn();
  await Promise.resolve();
  expect(reads).toBe(1);
});

test("turn boundaries swap the composer's send button for stop and back", async () => {
  const workspaceId = `actions-${crypto.randomUUID()}`;
  const f = fixture(async () => undefined, workspaceId);
  const publications: string[] = [];
  const arrivals = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let seen = 0;
  const subscription = await f.channel.subscribe(f.identifier, (html) => {
    publications.push(html);
    if (seen < arrivals.length) arrivals[seen++]!.resolve();
  }, createAgentsInTheCloudEventBus());
  try {
    await arrivals[0]!.promise;
    expect(publications[0]).toContain('type="submit"');
    publishWorkspaceAgentBusy({ workspaceId, agentKey: `agent:${f.agentId}`, busy: true });
    await arrivals[1]!.promise;
    const stop = publications[1]!;
    expect(stop).toContain(`target="${cliAgentActionsId(workspaceId, f.agentId)}"`);
    expect(stop).toContain('type="submit"');
    // Busy submits the hidden escape form instead of the composer (the builtin agent's abort pattern).
    expect(stop).toContain(`form="${cliEscapeFormId(workspaceId, f.agentId)}"`);
    expect(stop).toContain("data-activity-state=\"active\"");
    f.finishTurn();
    await arrivals[2]!.promise;
    const send = publications[2]!;
    expect(send).toContain('type="submit"');
    expect(send).not.toContain(`form="${cliEscapeFormId(workspaceId, f.agentId)}"`);
  } finally {
    subscription.unsubscribe();
  }
});

test("a finished turn refreshes the composer catalog with prompt templates it added", async () => {
  const workspaceId = `catalog-${crypto.randomUUID()}`;
  const f = fixture(async () => undefined, workspaceId);
  const published: string[] = [];
  const refreshed = Promise.withResolvers<void>();
  const subscription = await f.channel.subscribe(f.identifier, (html) => {
    published.push(html);
    if (published.length === 2) refreshed.resolve();
  }, createAgentsInTheCloudEventBus());
  try {
    expect(published[0]).not.toContain("/ship");
    const prompts = join(workspaceWorkHostPath(workspaceId), ".agents-in-the-cloud/prompts");
    await mkdir(prompts, { recursive: true });
    await writeFile(join(prompts, "ship.md"), "---\ncomposer-button: true\nshortcut: s\n---\nShip it");
    f.finishTurn();
    await refreshed.promise;
    expect(published[1]).toContain(`target="${cliCompletionCatalogId(workspaceId, f.agentId)}"`);
    expect(published[1]).toContain('data-command-trigger="/ship"');
  } finally {
    subscription.unsubscribe();
  }
});
