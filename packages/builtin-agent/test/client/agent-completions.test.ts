import { agentConnectionShouldRun } from "../../src/client/agent-pane.ts";
import { forwardAgentTerminalWheel, terminalOutputHasPrintableText } from "../../src/client/terminal-controller.ts";
import { describe, expect, mock, test } from "bun:test";
import { type AgentCompletionInput, agentCompletionRequest, agentComposerPrimaryAction, agentComposerTextStorageKey, composerPromptSuggestion, fileCompletionPrefix, insertSlashCommand, navigatePromptHistory, promptSuggestionKeyAction, promptTemplateShortcutConflict } from "@agents-in-the-cloud/agent/client/agent-controllers";

function input(value: string, cursor = value.length): AgentCompletionInput {
  return {
    value,
    selectionStart: cursor,
    selectionEnd: cursor,
    setSelectionRange(start, end) {
      this.selectionStart = start ?? 0;
      this.selectionEnd = end ?? 0;
    },
  };
}

describe("Agent pane visibility", () => {
  test("runs live connections only while logically visible in a visible document", () => {
    expect(agentConnectionShouldRun(true, "visible")).toBe(true);
    expect(agentConnectionShouldRun(false, "visible")).toBe(false);
    expect(agentConnectionShouldRun(true, "hidden")).toBe(false);
  });

  test("keys durable composer text by immutable conversation identity", () => {
    expect(agentComposerTextStorageKey("workspace-1", "conversation-1")).toBe('agents-in-the-cloud.agentComposerText:["workspace-1","conversation-1"]');
    expect(agentComposerTextStorageKey("workspace-1", "conversation-2")).not.toBe(agentComposerTextStorageKey("workspace-1", "conversation-1"));
    expect(agentComposerTextStorageKey("workspace-2", "conversation-1")).not.toBe(agentComposerTextStorageKey("workspace-1", "conversation-1"));
  });

  test("uses attachments as message content when choosing the busy primary action", () => {
    expect(agentComposerPrimaryAction(true, "", 0)).toBe("abort");
    expect(agentComposerPrimaryAction(true, "", 1)).toBe("steer");
    expect(agentComposerPrimaryAction(true, "Follow up", 0)).toBe("steer");
    expect(agentComposerPrimaryAction(false, "", 0)).toBe("send");
    expect(agentComposerPrimaryAction(true, "Later", 0, true, "followUp")).toBe("followUp");
    expect(agentComposerPrimaryAction(true, "", 0, true, "followUp")).toBe("abort");
  });
});

describe("agent prompt suggestions", () => {
  const key = (key: string, modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers });

  test("a suggestion steps aside for staged attachments", () => {
    expect(composerPromptSuggestion(" Run the tests \n", 0)).toBe("Run the tests");
    expect(composerPromptSuggestion("Run the tests", 1)).toBeUndefined();
    expect(composerPromptSuggestion("  ", 0)).toBeUndefined();
  });

  test("Tab and the right arrow write a suggestion in, sending sends it unless that would stop work", () => {
    expect(promptSuggestionKeyAction(key("Tab"), true)).toBe("accept");
    expect(promptSuggestionKeyAction(key("ArrowRight"), false)).toBe("accept");
    expect(promptSuggestionKeyAction(key("Enter", { metaKey: true }), true)).toBe("send");
    expect(promptSuggestionKeyAction(key("Enter", { ctrlKey: true }), false)).toBeUndefined();
    expect(promptSuggestionKeyAction(key("Enter"), true)).toBeUndefined();
    expect(promptSuggestionKeyAction(key("Tab", { shiftKey: true }), true)).toBeUndefined();
    expect(promptSuggestionKeyAction(key("ArrowUp"), true)).toBeUndefined();
  });
});

describe("agent terminal output", () => {
  test("does not treat terminal initialization escapes as visible output", () => {
    const initialization = "\x1b[?1049h\x1b[H\x1b[2J\x1b=\x1b(B\x1b[m\r\n";
    expect(terminalOutputHasPrintableText(initialization)).toBe(false);
    expect(terminalOutputHasPrintableText(`${initialization}ready\r\n`)).toBe(true);
  });

  test("forwards live terminal wheel input to the agent transcript", () => {
    const transcript = { scrollTop: 120, clientHeight: 500 };
    const terminal = { closest: () => transcript };
    const preventDefault = mock(() => {});
    const stopPropagation = mock(() => {});
    const event = { deltaY: 3, deltaMode: 1, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2, ctrlKey: false, preventDefault, stopPropagation };

    expect(forwardAgentTerminalWheel(terminal, event)).toBe(true);
    expect(transcript.scrollTop).toBe(168);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });
});

describe("agent prompt history", () => {
  test("cycles backward through prompts and forward to the original draft", () => {
    const prompts = ["first", "second", "third"];
    const latest = navigatePromptHistory(undefined, "up", "unfinished draft", prompts)!;
    expect(latest.value).toBe("third");

    const previous = navigatePromptHistory(latest.state, "up", latest.value, prompts)!;
    expect(previous.value).toBe("second");
    const oldest = navigatePromptHistory(previous.state, "up", previous.value, prompts)!;
    expect(navigatePromptHistory(oldest.state, "up", oldest.value, prompts)!.value).toBe("first");

    const next = navigatePromptHistory(oldest.state, "down", oldest.value, prompts)!;
    expect(next.value).toBe("second");
    const newest = navigatePromptHistory(next.state, "down", next.value, prompts)!;
    expect(newest.value).toBe("third");
    expect(navigatePromptHistory(newest.state, "down", newest.value, prompts)).toEqual({ state: undefined, value: "unfinished draft" });
  });

  test("does not start by navigating down or without previous prompts", () => {
    expect(navigatePromptHistory(undefined, "down", "draft", ["first"])).toBeUndefined();
    expect(navigatePromptHistory(undefined, "up", "draft", [])).toBeUndefined();
  });
});

describe("agent prompt completion activation", () => {
  test("prompt template buttons appear only before the user types", () => {
    expect(agentCompletionRequest(input(""))).toBeUndefined();
    expect(agentCompletionRequest(input(" "))).toBeUndefined();
    expect(agentCompletionRequest(input("draft"))).toBeUndefined();
  });

  test("slash resources and @ references are the only typed automatic completions", () => {
    expect(agentCompletionRequest(input("/review"))).toEqual({ kind: "slash-command", query: "review" });
    expect(agentCompletionRequest(input("/skill:review"))).toEqual({ kind: "slash-command", query: "skill:review" });
    expect(agentCompletionRequest(input("look at @packages/agent"))).toEqual({ kind: "file", query: "packages/agent", mode: "fuzzy" });
    expect(agentCompletionRequest(input("look at packages/agent/src/"))).toBeUndefined();
    expect(agentCompletionRequest(input("look at ./packages"))).toBeUndefined();
    expect(agentCompletionRequest(input("look at ~/notes/"))).toBeUndefined();
  });

  test("Tab explicitly completes an ordinary word or path", () => {
    expect(agentCompletionRequest(input("look at packages/agent/src/"), true)).toEqual({ kind: "file", query: "packages/agent/src/", mode: "direct" });
    expect(agentCompletionRequest(input("look at rend"), true)).toEqual({ kind: "file", query: "rend", mode: "direct" });
  });

  test("a leading absolute path can fall through from slash resources to Tab completion", () => {
    expect(agentCompletionRequest(input("/tmp"))).toEqual({ kind: "slash-command", query: "tmp" });
    expect(agentCompletionRequest(input("/tmp"), true)).toEqual({ kind: "file", query: "/tmp", mode: "direct" });
    expect(agentCompletionRequest(input("/tmp/bla"))).toBeUndefined();
    expect(agentCompletionRequest(input("/tmp/bla"), true)).toEqual({ kind: "file", query: "/tmp/bla", mode: "direct" });
  });

  test("rejects prompt-template shortcuts already assigned to AgentsInTheCloud commands", () => {
    const commands = [
      { label: "Open VS Code", binding: "Meta+Alt+KeyV" },
      { label: "New Terminal", binding: "Meta+Alt+KeyT" },
    ];

    expect(promptTemplateShortcutConflict("v", commands, true)?.label).toBe("Open VS Code");
    expect(promptTemplateShortcutConflict("s", commands, true)).toBeUndefined();
    // Canonical ⌘ bindings own the Ctrl+Alt combo on other platforms too.
    expect(promptTemplateShortcutConflict("v", commands, false)?.label).toBe("Open VS Code");
    expect(promptTemplateShortcutConflict("s", commands, false)).toBeUndefined();
    expect(promptTemplateShortcutConflict("v", [{ label: "Paste", binding: "Control+Alt+KeyV" }], false)?.label).toBe("Paste");
  });

  test("a selected prompt template replaces a partial trigger before inline expansion", () => {
    const textarea = input("/rev");
    const option = { dataset: { commandTrigger: "/review" } };

    insertSlashCommand(option, textarea);
    expect(textarea.value).toBe("/review ");
    expect(textarea.selectionStart).toBe(8);
  });

  test("a selected skill inserts Pi's namespaced command", () => {
    const textarea = input("/skill:rev");
    const option = { dataset: { commandTrigger: "/skill:review" } };

    insertSlashCommand(option, textarea);
    expect(textarea.value).toBe("/skill:review ");
    expect(textarea.selectionStart).toBe(14);
  });

  test("file token extraction supports quoted and in-sentence paths", () => {
    expect(fileCompletionPrefix(input('open @"path with sp'))).toBe('@"path with sp');
    expect(fileCompletionPrefix(input("open /tmp/bla"))).toBe("/tmp/bla");
  });
});
