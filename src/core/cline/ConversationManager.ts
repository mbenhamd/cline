import { Anthropic } from "@anthropic-ai/sdk";
import fs from "fs/promises";
import * as path from "path";
import { ClineMessage } from "../../shared/ExtensionMessage";
import { ClineProvider, GlobalFileNames } from "../webview/ClineProvider";
import { fileExistsAtPath } from "../../utils/fs";
import { getApiMetrics } from "../../shared/getApiMetrics";
import { combineApiRequests } from "../../shared/combineApiRequests";
import { findLastIndex } from "../../shared/array";
import { HistoryItem } from "../../shared/HistoryItem";

export class ConversationManager {
  private taskId: string;
  private providerRef: WeakRef<ClineProvider>;
  apiConversationHistory: Anthropic.MessageParam[] = [];
  clineMessages: ClineMessage[] = [];

  constructor(taskId: string, providerRef: WeakRef<ClineProvider>) {
    this.taskId = taskId;
    this.providerRef = providerRef;
  }

  private async ensureTaskDirectoryExists(): Promise<string> {
    const globalStoragePath = this.providerRef.deref()?.context.globalStorageUri.fsPath;
    if (!globalStoragePath) {
      throw new Error("Global storage uri is invalid");
    }
    const taskDir = path.join(globalStoragePath, "tasks", this.taskId);
    await fs.mkdir(taskDir, { recursive: true });
    return taskDir;
  }

  async getSavedApiConversationHistory(): Promise<Anthropic.MessageParam[]> {
    const filePath = path.join(await this.ensureTaskDirectoryExists(), GlobalFileNames.apiConversationHistory);
    const fileExists = await fileExistsAtPath(filePath);
    if (fileExists) {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    }
    return [];
  }

  async addToApiConversationHistory(message: Anthropic.MessageParam): Promise<void> {
    this.apiConversationHistory.push(message);
    await this.saveApiConversationHistory();
  }

  async overwriteApiConversationHistory(newHistory: Anthropic.MessageParam[]): Promise<void> {
    this.apiConversationHistory = newHistory;
    await this.saveApiConversationHistory();
  }

  private async saveApiConversationHistory(): Promise<void> {
    try {
      const filePath = path.join(await this.ensureTaskDirectoryExists(), GlobalFileNames.apiConversationHistory);
      await fs.writeFile(filePath, JSON.stringify(this.apiConversationHistory));
    } catch (error) {
      console.error("Failed to save API conversation history:", error);
    }
  }

  async getSavedClineMessages(): Promise<ClineMessage[]> {
    const filePath = path.join(await this.ensureTaskDirectoryExists(), GlobalFileNames.uiMessages);
    if (await fileExistsAtPath(filePath)) {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    } else {
      const oldPath = path.join(await this.ensureTaskDirectoryExists(), "claude_messages.json");
      if (await fileExistsAtPath(oldPath)) {
        const data = JSON.parse(await fs.readFile(oldPath, "utf8"));
        await fs.unlink(oldPath);
        return data;
      }
    }
    return [];
  }

  async addToClineMessages(message: ClineMessage): Promise<void> {
    this.clineMessages.push(message);
    await this.saveClineMessages();
  }

  async overwriteClineMessages(newMessages: ClineMessage[]): Promise<void> {
    this.clineMessages = newMessages;
    await this.saveClineMessages();
  }

  async saveClineMessages(): Promise<void> {
    try {
      const filePath = path.join(await this.ensureTaskDirectoryExists(), GlobalFileNames.uiMessages);
      await fs.writeFile(filePath, JSON.stringify(this.clineMessages));

      const apiMetrics = getApiMetrics(combineApiRequests(this.clineMessages.slice(1)));
      const taskMessage = this.clineMessages[0];
      const lastRelevantMessageIndex = findLastIndex(
        this.clineMessages,
        (m: ClineMessage) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")
      );

      if (taskMessage && lastRelevantMessageIndex !== -1) {
        const lastRelevantMessage = this.clineMessages[lastRelevantMessageIndex];
        if (lastRelevantMessage) {
          await this.providerRef.deref()?.updateTaskHistory({
            id: this.taskId,
            ts: lastRelevantMessage.ts,
            task: taskMessage.text ?? "",
            tokensIn: apiMetrics.totalTokensIn,
            tokensOut: apiMetrics.totalTokensOut,
            cacheWrites: apiMetrics.totalCacheWrites,
            cacheReads: apiMetrics.totalCacheReads,
            totalCost: apiMetrics.totalCost,
          } as HistoryItem);
        }
      }
    } catch (error) {
      console.error("Failed to save cline messages:", error);
    }
  }
}
