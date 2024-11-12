import { ClineAsk, ClineMessage, ClineSay } from "../../shared/ExtensionMessage";
import { ClineAskResponse } from "../../shared/WebviewMessage";
import { ClineProvider } from "../webview/ClineProvider";
import { ConversationManager } from "./ConversationManager";
import pWaitFor from "p-wait-for";

export class WebviewCommunicator {
  private providerRef: WeakRef<ClineProvider>;
  private abortFlag: () => boolean;
  private askResponse?: ClineAskResponse;
  private askResponseText?: string;
  private askResponseImages?: string[];
  private lastMessageTs?: number;
  private conversationManager: ConversationManager;

  constructor(
    providerRef: WeakRef<ClineProvider>, 
    abortFlag: () => boolean,
    conversationManager: ConversationManager
  ) {
    this.providerRef = providerRef;
    this.abortFlag = abortFlag;
    this.conversationManager = conversationManager;
  }

  async ask(
    type: ClineAsk,
    text?: string,
    partial?: boolean
  ): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
    if (this.abortFlag()) {
      throw new Error("Cline instance aborted");
    }

    let askTs: number;
    if (partial !== undefined) {
      const lastMessage = this.conversationManager.clineMessages.at(-1);
      const isUpdatingPreviousPartial =
        lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type;
      
      if (partial) {
        if (isUpdatingPreviousPartial) {
          lastMessage.text = text;
          lastMessage.partial = partial;
          await this.providerRef
            .deref()
            ?.postMessageToWebview({ type: "partialMessage", partialMessage: lastMessage });
          throw new Error("Current ask promise was ignored 1");
        } else {
          askTs = Date.now();
          this.lastMessageTs = askTs;
          await this.conversationManager.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, partial });
          await this.providerRef.deref()?.postStateToWebview();
          throw new Error("Current ask promise was ignored 2");
        }
      } else {
        if (isUpdatingPreviousPartial) {
          this.askResponse = undefined;
          this.askResponseText = undefined;
          this.askResponseImages = undefined;
          askTs = lastMessage.ts;
          this.lastMessageTs = askTs;
          lastMessage.text = text;
          lastMessage.partial = false;
          await this.conversationManager.saveClineMessages();
          await this.providerRef
            .deref()
            ?.postMessageToWebview({ type: "partialMessage", partialMessage: lastMessage });
        } else {
          this.askResponse = undefined;
          this.askResponseText = undefined;
          this.askResponseImages = undefined;
          askTs = Date.now();
          this.lastMessageTs = askTs;
          await this.conversationManager.addToClineMessages({ ts: askTs, type: "ask", ask: type, text });
          await this.providerRef.deref()?.postStateToWebview();
        }
      }
    } else {
      this.askResponse = undefined;
      this.askResponseText = undefined;
      this.askResponseImages = undefined;
      askTs = Date.now();
      this.lastMessageTs = askTs;
      await this.conversationManager.addToClineMessages({ ts: askTs, type: "ask", ask: type, text });
      await this.providerRef.deref()?.postStateToWebview();
    }

    await pWaitFor(() => this.askResponse !== undefined || this.lastMessageTs !== askTs, { interval: 100 });
    if (this.lastMessageTs !== askTs) {
      throw new Error("Current ask promise was ignored");
    }
    const result = { response: this.askResponse!, text: this.askResponseText, images: this.askResponseImages };
    this.askResponse = undefined;
    this.askResponseText = undefined;
    this.askResponseImages = undefined;
    return result;
  }

  async handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[]): Promise<void> {
    this.askResponse = askResponse;
    this.askResponseText = text;
    this.askResponseImages = images;
  }

  async say(type: ClineSay, text?: string, images?: string[], partial?: boolean): Promise<void> {
    if (this.abortFlag()) {
      throw new Error("Cline instance aborted");
    }

    if (partial !== undefined) {
      const lastMessage = this.conversationManager.clineMessages.at(-1);
      const isUpdatingPreviousPartial =
        lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type;
      
      if (partial) {
        if (isUpdatingPreviousPartial) {
          lastMessage.text = text;
          lastMessage.images = images;
          lastMessage.partial = partial;
          await this.providerRef
            .deref()
            ?.postMessageToWebview({ type: "partialMessage", partialMessage: lastMessage });
        } else {
          const sayTs = Date.now();
          this.lastMessageTs = sayTs;
          await this.conversationManager.addToClineMessages({ ts: sayTs, type: "say", say: type, text, images, partial });
          await this.providerRef.deref()?.postStateToWebview();
        }
      } else {
        if (isUpdatingPreviousPartial) {
          this.lastMessageTs = lastMessage.ts;
          lastMessage.text = text;
          lastMessage.images = images;
          lastMessage.partial = false;
          await this.conversationManager.saveClineMessages();
          await this.providerRef
            .deref()
            ?.postMessageToWebview({ type: "partialMessage", partialMessage: lastMessage });
        } else {
          const sayTs = Date.now();
          this.lastMessageTs = sayTs;
          await this.conversationManager.addToClineMessages({ ts: sayTs, type: "say", say: type, text, images });
          await this.providerRef.deref()?.postStateToWebview();
        }
      }
    } else {
      const sayTs = Date.now();
      this.lastMessageTs = sayTs;
      await this.conversationManager.addToClineMessages({ ts: sayTs, type: "say", say: type, text, images });
      await this.providerRef.deref()?.postStateToWebview();
    }
  }

  async sayAndCreateMissingParamError(toolName: string, paramName: string, relPath?: string): Promise<string> {
    await this.say(
      "error",
      `Cline tried to use ${toolName}${
        relPath ? ` for '${relPath}'` : ""
      } without value for required parameter '${paramName}'. Retrying...`
    );
    return `Error: Missing required parameter '${paramName}' for ${toolName}`;
  }
}
