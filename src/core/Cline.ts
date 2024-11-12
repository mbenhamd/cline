import { ApiHandler } from '../api';
import { ClineProvider } from './webview/ClineProvider';
import { HistoryItem } from '../shared/HistoryItem';
import { ConversationManager } from './cline/ConversationManager';
import { WebviewCommunicator } from './cline/WebviewCommunicator';
import { ContextLoader } from './cline/ContextLoader';
import { ToolExecutor } from './cline/ToolExecutor';
import { AssistantMessagePresenter } from './cline/AssistantMessagePresenter';
import { Assistant } from './cline/Assistant';
import { TaskManager } from './cline/TaskManager';

interface ClineConfig {
  provider: ClineProvider;
  api: ApiHandler;
  conversationManager: ConversationManager;
  webviewCommunicator: WebviewCommunicator;
  contextLoader: ContextLoader;
  toolExecutor: ToolExecutor;
  assistantMessagePresenter: AssistantMessagePresenter;
  assistant: Assistant;
  taskManager: TaskManager;
  historyItem?: HistoryItem;
  task?: string;
  images?: string[];
  customInstructions?: string;
  alwaysAllowReadOnly?: boolean;
  alwaysAllowWrite?: boolean;
  alwaysAllowExecute?: boolean;
}

class TaskInitializer {
  private taskManager: TaskManager;

  constructor(taskManager: TaskManager) {
    this.taskManager = taskManager;
  }

  async initialize(historyItem?: HistoryItem, task?: string, images?: string[]): Promise<void> {
    try {
      if (historyItem) {
        await this.taskManager.resumeTaskFromHistory();
      } else {
        await this.taskManager.startTask(task, images);
      }
    } catch (error) {
      console.error('Failed to initialize task:', error);
      throw error;
    }
  }
}

class TaskController {
  private taskManager: TaskManager;
  private isAborted: boolean = false;

  constructor(taskManager: TaskManager) {
    this.taskManager = taskManager;
  }

  abortTask(): void {
    this.isAborted = true;
    this.taskManager.abortTask();
    this.taskManager.terminalManager.disposeAll();
    this.taskManager.browserSession.closeBrowser();
  }

  async resumeTask(historyItem: HistoryItem): Promise<void> {
    if (this.isAborted) {
      throw new Error("Cannot resume task - task has been aborted");
    }
    return this.taskManager.resumeTaskFromHistory();
  }

  async startNewTask(task?: string, images?: string[]): Promise<void> {
    if (this.isAborted) {
      throw new Error("Cannot start new task - current task has been aborted");
    }
    return this.taskManager.startTask(task, images);
  }

  isTaskAborted(): boolean {
    return this.isAborted;
  }
}

export class Cline {
  private readonly taskId: string;
  private readonly taskInitializer: TaskInitializer;
  private readonly taskController: TaskController;

  private constructor(
    taskId: string,
    taskInitializer: TaskInitializer,
    taskController: TaskController,
  ) {
    this.taskId = taskId;
    this.taskInitializer = taskInitializer;
    this.taskController = taskController;
  }

  static async create(config: ClineConfig): Promise<Cline> {
    if (!config.historyItem && !config.task && !config.images) {
      throw new Error("Either historyItem or task/images must be provided");
    }

    const taskId = config.historyItem?.id ?? Date.now().toString();
    const taskInitializer = new TaskInitializer(config.taskManager);
    const taskController = new TaskController(config.taskManager);

    const cline = new Cline(taskId, taskInitializer, taskController);

    try {
      await taskInitializer.initialize(config.historyItem, config.task, config.images);
    } catch (error) {
      console.error('Failed to initialize task:', error);
      throw error;
    }

    return cline;
  }

  public getTaskId(): string {
    return this.taskId;
  }

  public isTaskAborted(): boolean {
    return this.taskController.isTaskAborted();
  }

  public abortTask(): void {
    this.taskController.abortTask();
  }

  public async resumeTask(historyItem: HistoryItem): Promise<void> {
    return this.taskController.resumeTask(historyItem);
  }

  public async startNewTask(task?: string, images?: string[]): Promise<void> {
    return this.taskController.startNewTask(task, images);
  }
}

export type { ClineConfig };
