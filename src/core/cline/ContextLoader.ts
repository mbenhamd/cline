import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { TerminalManager } from "../../integrations/terminal/TerminalManager";
import { UrlContentFetcher } from "../../services/browser/UrlContentFetcher";
import { listFiles } from "../../services/glob/list-files";
import { formatResponse } from "../prompts/responses";
import { parseMentions } from "../mentions";
import { arePathsEqual } from "../../utils/path";
import { UserContent } from "./types";
import delay from "delay";
import pWaitFor from "p-wait-for";

export class ContextLoader {
  private cwd: string;
  private terminalManager: TerminalManager;
  private urlContentFetcher: UrlContentFetcher;
  private didEditFile: boolean = false;

  constructor(cwd: string, terminalManager: TerminalManager, urlContentFetcher: UrlContentFetcher) {
    this.cwd = cwd;
    this.terminalManager = terminalManager;
    this.urlContentFetcher = urlContentFetcher;
  }

  getCwd(): string {
    return this.cwd;
  }

  setDidEditFile(didEdit: boolean): void {
    this.didEditFile = didEdit;
  }

  async loadContext(userContent: UserContent, includeFileDetails: boolean = false): Promise<[UserContent, string]> {
    return await Promise.all([
      Promise.all(
        userContent.map(async (block) => {
          if (block.type === "text") {
            return {
              ...block,
              text: await parseMentions(block.text, this.cwd, this.urlContentFetcher),
            };
          } else if (block.type === "tool_result") {
            const isUserMessage = (text: string) => text.includes("<feedback>") || text.includes("<answer>");
            if (typeof block.content === "string" && isUserMessage(block.content)) {
              return {
                ...block,
                content: await parseMentions(block.content, this.cwd, this.urlContentFetcher),
              };
            } else if (Array.isArray(block.content)) {
              const parsedContent = await Promise.all(
                block.content.map(async (contentBlock) => {
                  if (contentBlock.type === "text" && isUserMessage(contentBlock.text)) {
                    return {
                      ...contentBlock,
                      text: await parseMentions(contentBlock.text, this.cwd, this.urlContentFetcher),
                    };
                  }
                  return contentBlock;
                })
              );
              return {
                ...block,
                content: parsedContent,
              };
            }
          }
          return block;
        })
      ),
      this.getEnvironmentDetails(includeFileDetails),
    ]);
  }

  async getEnvironmentDetails(includeFileDetails: boolean = false): Promise<string> {
    let details = "";

    details += "\n\n# VSCode Visible Files";
    const visibleFiles = vscode.window.visibleTextEditors
      ?.map((editor) => editor.document?.uri?.fsPath)
      .filter(Boolean)
      .map((absolutePath) => path.relative(this.cwd, absolutePath).toPosix())
      .join("\n");
    if (visibleFiles) {
      details += `\n${visibleFiles}`;
    } else {
      details += "\n(No visible files)";
    }

    details += "\n\n# VSCode Open Tabs";
    const openTabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .map((tab) => (tab.input as vscode.TabInputText)?.uri?.fsPath)
      .filter(Boolean)
      .map((absolutePath) => path.relative(this.cwd, absolutePath).toPosix())
      .join("\n");
    if (openTabs) {
      details += `\n${openTabs}`;
    } else {
      details += "\n(No open tabs)";
    }

    const busyTerminals = this.terminalManager.getTerminals(true);
    const inactiveTerminals = this.terminalManager.getTerminals(false);

    if (busyTerminals.length > 0 && this.didEditFile) {
      await delay(300);
    }

    if (busyTerminals.length > 0) {
      await pWaitFor(() => busyTerminals.every((t) => !this.terminalManager.isProcessHot(t.id)), {
        interval: 100,
        timeout: 15_000,
      }).catch(() => {});
    }

    this.didEditFile = false;

    let terminalDetails = "";
    if (busyTerminals.length > 0) {
      terminalDetails += "\n\n# Actively Running Terminals";
      for (const busyTerminal of busyTerminals) {
        terminalDetails += `\n## Original command: \`${busyTerminal.lastCommand}\``;
        const newOutput = this.terminalManager.getUnretrievedOutput(busyTerminal.id);
        if (newOutput) {
          terminalDetails += `\n### New Output\n${newOutput}`;
        }
      }
    }

    if (inactiveTerminals.length > 0) {
      const inactiveTerminalOutputs = new Map<number, string>();
      for (const inactiveTerminal of inactiveTerminals) {
        const newOutput = this.terminalManager.getUnretrievedOutput(inactiveTerminal.id);
        if (newOutput) {
          inactiveTerminalOutputs.set(inactiveTerminal.id, newOutput);
        }
      }
      if (inactiveTerminalOutputs.size > 0) {
        terminalDetails += "\n\n# Inactive Terminals";
        for (const [terminalId, newOutput] of inactiveTerminalOutputs) {
          const inactiveTerminal = inactiveTerminals.find((t) => t.id === terminalId);
          if (inactiveTerminal) {
            terminalDetails += `\n## ${inactiveTerminal.lastCommand}`;
            terminalDetails += `\n### New Output\n${newOutput}`;
          }
        }
      }
    }

    if (terminalDetails) {
      details += terminalDetails;
    }

    if (includeFileDetails) {
      details += `\n\n# Current Working Directory (${this.cwd.toPosix()}) Files\n`;
      const isDesktop = arePathsEqual(this.cwd, path.join(os.homedir(), "Desktop"));
      if (isDesktop) {
        details += "(Desktop files not shown automatically. Use list_files to explore if needed.)";
      } else {
        const [files, didHitLimit] = await listFiles(this.cwd, true, 200);
        const result = formatResponse.formatFilesList(this.cwd, files, didHitLimit);
        details += result;
      }
    }

    return `<environment_details>\n${details.trim()}\n</environment_details>`;
  }
}
