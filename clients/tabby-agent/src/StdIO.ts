import { CancelablePromise } from "./generated";
import { AgentFunction, AgentEvent, Agent, agentEventNames } from "./Agent";
import { rootLogger } from "./logger";
import { splitLines } from "./utils";

type AgentFunctionRequest<T extends keyof AgentFunction> = [
  id: number,
  data: {
    func: T;
    args: Parameters<AgentFunction[T]>;
  }
];

type CancellationRequest = [
  id: number,
  data: {
    func: "cancelRequest";
    args: [id: number];
  }
];

type Request = AgentFunctionRequest<any> | CancellationRequest;

type AgentFunctionResponse<T extends keyof AgentFunction> = [
  id: number, // Matched request id
  data: ReturnType<AgentFunction[T]>
];

type AgentEventNotification = {
  id: 0;
  data: AgentEvent;
};

type CancellationResponse = [
  id: number, // Matched request id
  data: boolean
];

type Response = AgentFunctionResponse<any> | AgentEventNotification | CancellationResponse;

/**
 * Every request and response should be single line JSON string and end with a newline.
 */
export class StdIO {
  private readonly inStream: NodeJS.ReadStream = process.stdin;
  private readonly outStream: NodeJS.WriteStream = process.stdout;
  private readonly logger = rootLogger.child({ component: "StdIO" });

  private buffer: string = "";
  private ongoingRequests: { [id: number]: PromiseLike<any> } = {};

  private agent: Agent | null = null;

  constructor() {}

  private handleInput(data: Buffer): void {
    const input = data.toString();
    this.buffer += input;
    const lines = splitLines(this.buffer);
    if (lines.length < 1) {
      return;
    }
    if (lines[lines.length - 1].endsWith("\n")) {
      this.buffer = "";
    } else {
      this.buffer = lines.pop()!;
    }
    for (const line of lines) {
      let request: Request | null = null;
      try {
        request = JSON.parse(line) as Request;
      } catch (error) {
        this.logger.error({ error }, `Failed to parse request: ${line}`);
        continue;
      }
      this.logger.debug({ request }, "Received request");
      this.handleRequest(request).then((response) => {
        this.sendResponse(response);
        this.logger.debug({ response }, "Sent response");
      });
    }
  }

  private async handleRequest(request: Request): Promise<Response> {
    const response: Response = [0, null];
    try {
      if (!this.agent) {
        throw new Error(`Agent not bound.\n`);
      }
      response[0] = request[0];

      let funcName = request[1].func;
      if (funcName === "cancelRequest") {
        response[1] = this.cancelRequest(request as CancellationRequest);
      } else {
        let func = this.agent[funcName];
        if (!func) {
          throw new Error(`Unknown function: ${funcName}`);
        }
        const result = func.apply(this.agent, request[1].args);
        if (typeof result === "object" && typeof result.then === "function") {
          this.ongoingRequests[request[0]] = result;
          response[1] = await result;
          delete this.ongoingRequests[request[0]];
        } else {
          response[1] = result;
        }
      }
    } catch (error) {
      this.logger.error({ error }, `Failed to handle request: ${JSON.stringify(request)}`);
    } finally {
      return response;
    }
  }

  private cancelRequest(request: CancellationRequest): boolean {
    const ongoing = this.ongoingRequests[request[1].args[0]];
    if (!ongoing) {
      return false;
    }
    if (ongoing instanceof CancelablePromise) {
      ongoing.cancel();
    }
    delete this.ongoingRequests[request[1].args[0]];
    return true;
  }

  private sendResponse(response: Response): void {
    this.outStream.write(JSON.stringify(response) + "\n");
  }

  bind(agent: Agent): void {
    this.agent = agent;
    for (const eventName of agentEventNames) {
      this.agent.on(eventName, (event) => {
        this.sendResponse([0, event]);
      });
    }
  }

  listen() {
    this.inStream.on("data", this.handleInput.bind(this));
  }
}
