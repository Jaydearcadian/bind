import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHostedMcpServer } from "../../mcp/src/hosted.js";

/**
 * The hosted factory passes the request's abort signal to every API call (docs/decisions/0075, point 6). A fetch that hangs until
 * it is aborted must be called once, never retried, and the tool must answer after the abort.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the hosted factory's abort chain", () => {
  it("an aborted request stops its API call: the fetch is made once, and no further call follows", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      (_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          calls += 1;
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        })
    );

    const controller = new AbortController();
    const mcp = createHostedMcpServer({
      baseUrl: "http://127.0.0.1:9",
      token: `bnd_${"A".repeat(43)}`,
      workspaceId: "ws-abort-check",
      log: () => undefined,
      headers: { "x-request-id": "abort-check-0001" },
      signal: controller.signal,
    });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const client = new Client({ name: "abort-check", version: "0.0.0" });
    await client.connect(clientSide);

    const pending = client.callTool({ name: "get_workspace", arguments: {} }) as Promise<CallToolResult>;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(1);
    controller.abort();
    const answer = await pending;
    expect(answer.isError).toBe(true);

    // Give any retry the chance to run. None does: the call was aborted by the caller, not lost to the network.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls).toBe(1);
    await client.close();
    await mcp.close();
  });
});
