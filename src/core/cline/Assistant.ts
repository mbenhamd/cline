import { ApiHandler } from "../../api";
import { ApiStream } from "../../api/transform/stream";
import { ConversationManager } from "./ConversationManager";
import { ToolExecutor } from "./ToolExecutor";
import { WebviewCommunicator } from "./WebviewCommunicator";
import { ContextLoader } from "./ContextLoader";
import { AssistantMessagePresenter } from "./AssistantMessagePresenter";
import { parseAssistantMessage } from "../assistant-message";
import { formatResponse } from "../prompts/responses";
import { SYSTEM_PROMPT, addCustomInstructions } from "../prompts/system";
import { truncateHalfConversation } from "../sliding-window";
import { findLastIndex } from "../../shared/array";
import { ClineApiReqInfo } from "../../shared/ExtensionMessage";
import { serializeError } from "serialize-error";
import pWaitFor from "p-wait-for";
import { 
  UserContent, 
  TextBlockParam, 
  AnthropicBlock,
  isTextBlock,
  isToolUseBlock,
  isToolResultBlock,
  isImageBlock,
  AssistantMessageContent
} from "./types";
import { ClineProvider } from "../webview/ClineProvider";
import { formatContentBlockToMarkdown } from "../../integrations/misc/export-markdown";

export class Assistant {
  private api: ApiHandler;
  private conversationManager: ConversationManager;
  private toolExecutor: ToolExecutor;
  private webviewCommunicator: WebviewCommunicator;
  private contextLoader: ContextLoader;
  private assistantMessagePresenter: AssistantMessagePresenter;
  private abortFlag: () => boolean;
  private customInstructions?: string;
  private providerRef: WeakRef<ClineProvider>;

  constructor(
    api: ApiHandler,
    conversationManager: ConversationManager,
    toolExecutor: ToolExecutor,
    webviewCommunicator: WebviewCommunicator,
    contextLoader: ContextLoader,
    assistantMessagePresenter: AssistantMessagePresenter,
    abortFlag: () => boolean,
    providerRef: WeakRef<ClineProvider>,
    customInstructions?: string
  ) {
    this.api = api;
    this.conversationManager = conversationManager;
    this.toolExecutor = toolExecutor;
    this.webviewCommunicator = webviewCommunicator;
    this.contextLoader = contextLoader;
    this.assistantMessagePresenter = assistantMessagePresenter;
    this.abortFlag = abortFlag;
    this.providerRef = providerRef;
    this.customInstructions = customInstructions;
  }

  async *attemptApiRequest(previousApiReqIndex: number): ApiStream {
    let systemPrompt = await SYSTEM_PROMPT(
      this.contextLoader.getCwd(), 
      this.api.getModel().info.supportsComputerUse ?? false
    );

    if (this.customInstructions && this.customInstructions.trim()) {
      systemPrompt += addCustomInstructions(this.customInstructions);
    }

    if (previousApiReqIndex >= 0) {
      const previousRequest = this.conversationManager.clineMessages[previousApiReqIndex];
      if (previousRequest && previousRequest.text) {
        const { tokensIn, tokensOut, cacheWrites, cacheReads }: ClineApiReqInfo = JSON.parse(
          previousRequest.text
        );
        const totalTokens = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0);
        const contextWindow = this.api.getModel().info.contextWindow || 128_000;
        const maxAllowedSize = Math.max(contextWindow - 40_000, contextWindow * 0.8);
        if (totalTokens >= maxAllowedSize) {
          const truncatedMessages = truncateHalfConversation(this.conversationManager.apiConversationHistory);
          await this.conversationManager.overwriteApiConversationHistory(truncatedMessages);
        }
      }
    }

    const stream = this.api.createMessage(systemPrompt, this.conversationManager.apiConversationHistory);
    const iterator = stream[Symbol.asyncIterator]();

    try {
      const firstChunk = await iterator.next();
      yield firstChunk.value;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(serializeError(error), null, 2);
      const { response } = await this.webviewCommunicator.ask(
        "api_req_failed",
        errorMessage
      );
      if (response !== "yesButtonClicked") {
        throw new Error("API request failed");
      }
      await this.webviewCommunicator.say("api_req_retried");
      yield* this.attemptApiRequest(previousApiReqIndex);
      return;
    }

    yield* iterator;
  }

  async handleTaskRequest(userContent: UserContent, includeFileDetails: boolean): Promise<boolean> {
    if (this.abortFlag()) {
      throw new Error("Cline instance aborted");
    }

    const formatBlockForDisplay = (block: UserContent[number]): string => {
      return formatContentBlockToMarkdown(block);
    };

    await this.webviewCommunicator.say(
      "api_req_started",
      JSON.stringify({
        request: userContent.map(formatBlockForDisplay).join("\n\n") + "\n\nLoading...",
      })
    );

    const [parsedUserContent, environmentDetails] = await this.contextLoader.loadContext(userContent, includeFileDetails);
    userContent = parsedUserContent;
    userContent.push({
      type: "text",
      text: environmentDetails,
    } as TextBlockParam);

    await this.conversationManager.addToApiConversationHistory({ role: "user", content: userContent });

    const lastApiReqIndex = findLastIndex(
      this.conversationManager.clineMessages,
      (m) => m.say === "api_req_started"
    );

    if (lastApiReqIndex !== -1) {
      const messages = this.conversationManager.clineMessages;
      if (messages[lastApiReqIndex]) {
        messages[lastApiReqIndex].text = JSON.stringify({
          request: userContent.map(formatBlockForDisplay).join("\n\n"),
        } as ClineApiReqInfo);

        await this.conversationManager.saveClineMessages();
        await this.providerRef?.deref()?.postStateToWebview();
      }
    }

    try {
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheWriteTokens = 0;
      let cacheReadTokens = 0;
      let totalCost: number | undefined;

      this.assistantMessagePresenter.reset();

      const stream = this.attemptApiRequest(lastApiReqIndex);
      let assistantMessage = "";

      for await (const chunk of stream) {
        if (this.abortFlag()) {
          break;
        }

        switch (chunk.type) {
          case "usage":
            inputTokens += chunk.inputTokens;
            outputTokens += chunk.outputTokens;
            cacheWriteTokens += chunk.cacheWriteTokens ?? 0;
            cacheReadTokens += chunk.cacheReadTokens ?? 0;
            totalCost = chunk.totalCost;
            break;
          case "text":
            assistantMessage += chunk.text;
            const prevLength = this.assistantMessagePresenter.getAssistantMessageContent().length;
            this.assistantMessagePresenter.setAssistantMessageContent(parseAssistantMessage(assistantMessage));
            if (this.assistantMessagePresenter.getAssistantMessageContent().length > prevLength) {
              this.assistantMessagePresenter.setUserMessageContentReady(false);
            }
            await this.presentAssistantMessage();
            break;
        }

        if (this.assistantMessagePresenter.isDidRejectTool()) {
          assistantMessage += "\n\n[Response interrupted by user feedback]";
          break;
        }
      }

      if (this.abortFlag()) {
        throw new Error("Cline instance aborted");
      }

      this.assistantMessagePresenter.setDidCompleteReadingStream(true);

      const partialBlocks = this.assistantMessagePresenter.getAssistantMessageContent().filter((block) => block.partial);
      partialBlocks.forEach((block: AssistantMessageContent) => {
        block.partial = false;
      });

      if (partialBlocks.length > 0) {
        await this.presentAssistantMessage();
      }

      this.updateApiReqMessage(lastApiReqIndex, {
        tokensIn: inputTokens,
        tokensOut: outputTokens,
        cacheWrites: cacheWriteTokens,
        cacheReads: cacheReadTokens,
        cost: totalCost,
      });

      await this.conversationManager.saveClineMessages();
      await this.providerRef?.deref()?.postStateToWebview();

      if (assistantMessage.length > 0) {
        await this.conversationManager.addToApiConversationHistory({
          role: "assistant",
          content: [{ type: "text", text: assistantMessage }],
        });

        await pWaitFor(() => this.assistantMessagePresenter.isUserMessageContentReady());

        const didToolUse = this.assistantMessagePresenter.getAssistantMessageContent().some(
          (block: AssistantMessageContent) => block.type === "tool_use"
        );

        if (!didToolUse) {
          this.assistantMessagePresenter.addToUserMessageContent({
            type: "text",
            text: formatResponse.noToolsUsed(),
          });
        }

        return await this.handleTaskRequest(this.assistantMessagePresenter.getUserMessageContent(), false);
      } else {
        await this.webviewCommunicator.say(
          "error",
          "Unexpected API Response: The language model did not provide any assistant messages."
        );
        await this.conversationManager.addToApiConversationHistory({
          role: "assistant",
          content: [{ type: "text", text: "Failure: I did not provide a response." }],
        });
      }

      return false;
    } catch (error) {
      return true;
    }
  }

  private formatContentBlock(block: AnthropicBlock): string {
    if (!block) return "";

    if (isTextBlock(block)) {
      return block.text;
    }
    if (isToolUseBlock(block)) {
      return `[Tool Use: ${block.name}]`;
    }
    if (isToolResultBlock(block)) {
      if (typeof block.content === "string") {
        return `[Tool Result: ${block.content}]`;
      }
      return `[Tool Result: ${JSON.stringify(block.content)}]`;
    }
    if (isImageBlock(block)) {
      if (block.source.type === "base64") {
        return `[Image: ${block.source.data}]`;
      }
      return "[Image]";
    }
    return "";
  }

  private updateApiReqMessage(index: number, metrics: Partial<ClineApiReqInfo>): void {
    if (index >= 0 && this.conversationManager.clineMessages[index]) {
      const message = this.conversationManager.clineMessages[index];
      const currentInfo = message.text ? JSON.parse(message.text) as ClineApiReqInfo : {};
      message.text = JSON.stringify({
        ...currentInfo,
        ...metrics,
      });
    }
  }

  private async presentAssistantMessage(): Promise<void> {
    await this.assistantMessagePresenter.presentAssistantMessage();
  }
}
