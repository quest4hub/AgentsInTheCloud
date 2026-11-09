import { expect, test } from "bun:test";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkspaceEgressProxy } from "../src/egress/egress-proxy.ts";
import { ensureMitmCa } from "../src/egress/mitm-ca.ts";
import { createHttpHooks } from "../src/secrets/placeholder-hooks.ts";
import { createWorkspaceSecretContext, forgetWorkspaceSecretContext, registerWorkspaceRequestTransform } from "../src/secrets/workspace-secrets.ts";

/**
 * Host-owned request bridges (the Pi CLI credential transform in production)
 * must intercept plain-HTTP CONNECT targets on non-443 ports: custom model
 * endpoints are commonly a local llama.cpp server. The bridge previously ran
 * only behind TLS interception, so every such tunnel was refused with
 * "MITM CONNECT only allowed to port 443" and the Pi CLI reported
 * "Connection error." Workspace secrets keep that restriction.
 */

const MARKER = "agents-in-the-cloud-test-plain-http-transform-marker";
const HOST = "plain-model.example";

registerWorkspaceRequestTransform("plain-http-transform-test", async (request, registerSecret) => {
  const authorization = request.headers.get("authorization");
  if (!authorization?.includes(MARKER)) return request;
  registerSecret("real-secret-value");
  const headers = new Headers(request.headers);
  headers.set("authorization", "Bearer real-secret-value");
  // SAFETY: Readable.toWeb returns a WHATWG ReadableStream at runtime. Node's
  // declaration differs from the DOM declaration only in overloads; Bun accepts it as BodyInit.
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, body: request.body };
  if (request.body) init.duplex = "half";
  return new Request(request.url, init);
}, async () => [HOST]);

function connectTunnel(socketPath: string, target: string): Promise<{ response: string; socket?: net.Socket }> {
  const opened = new Promise<{ response: string; socket?: net.Socket }>((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("error", error => { reject(error); });
    socket.setTimeout(5000, () => socket.destroy(new Error("CONNECT timeout")));
    let response = "";
    function received(data: Buffer) {
      response += data.toString();
      if (!response.includes("\r\n\r\n")) return;
      socket.off("data", received);
      // A non-2xx CONNECT answer ends the exchange; keep reading until the proxy closes.
      if (!/^HTTP\/1\.1 200/.test(response)) {
        socket.on("data", (chunk: Buffer) => { response += chunk.toString(); });
        socket.once("close", () => resolve({ response }));
        return;
      }
      resolve({ response, socket });
    }
    socket.once("connect", () => {
      socket.on("data", received);
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
  });
  return opened.then(async (result: { response: string; socket?: net.Socket }) => {
    if (!result.socket) return { response: result.response };
    const request = `GET /v1/models HTTP/1.1\r\nhost: ${HOST}:8000\r\nauthorization: Bearer ${MARKER}\r\nconnection: close\r\n\r\n`;
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = result.socket!;
      let data = "";
      socket.once("error", reject);
      socket.setTimeout(5000, () => socket.destroy(new Error("tunnel request timeout")));
      socket.on("data", chunk => { data += chunk.toString(); if (data.includes("\r\n\r\n")) { socket.end(); resolve(data); } });
      socket.write(request);
    }).finally(() => result.socket!.destroy());
    return { response: `${result.response}${reply}` };
  });
}

test("secret-matched hosts keep refusing non-443 CONNECTs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plain-http-secret-"));
  const socketPath = join(directory, "egress.sock");
  const hooks = createHttpHooks({ allowedHosts: ["*"], blockInternalRanges: false, secrets: { WORKSPACE_SECRET: { hosts: ["secret-model.example"], value: "real", placeholder: "WORKSPACE_SECRET_PLACEHOLDER" } } });
  const proxy = await startWorkspaceEgressProxy({
    socketPath,
    ca: await ensureMitmCa({ agentsInTheCloudDataDir: directory, dockerHostAgentsInTheCloudDataDir: directory, dockerBridgeHost: "127.0.0.1" }),
    getContext: async () => ({ workspaceId: "plain-http-secret-test", env: hooks.env, hooks: hooks.httpHooks, secrets: hooks.secrets }),
    upstreamDnsLookup: async hostname => [{ address: "8.8.4.4", family: 4 }],
    upstreamProxyForUrl: () => "",
    upstreamFetch: async () => new Response("should not be reached"),
  });
  try {
    const { response } = await connectTunnel(socketPath, "secret-model.example:8000");
    expect(response).toContain("MITM CONNECT only allowed to port 443");
  } finally {
    await proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("request-transform hosts intercept plain-HTTP CONNECT tunnels on non-443 ports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plain-http-transform-"));
  const socketPath = join(directory, "egress.sock");
  const workspaceId = "plain-http-transform-test";
  const upstreamRequests: Array<{ url: string; host: string | null; authorization: string | null }> = [];
  const proxy = await startWorkspaceEgressProxy({
    socketPath,
    ca: await ensureMitmCa({ agentsInTheCloudDataDir: directory, dockerHostAgentsInTheCloudDataDir: directory, dockerBridgeHost: "127.0.0.1" }),
    getContext: () => createWorkspaceSecretContext(workspaceId),
    upstreamDnsLookup: async hostname => [{ address: hostname === HOST ? "8.8.4.4" : "9.9.9.9", family: 4 }],
    upstreamProxyForUrl: () => "",
    upstreamFetch: async (url, init) => {
      // Direct egress fetches the pinned policy-checked address; the Host header keeps the logical name.
      upstreamRequests.push({ url, host: new Headers(init.headers).get("host"), authorization: new Headers(init.headers).get("authorization") });
      return new Response('{"data":[]}', { headers: { "content-type": "application/json" } });
    },
  });
  try {
    const { response } = await connectTunnel(socketPath, `${HOST}:8000`);
    expect(response).toContain("200 Connection Established");
    // The tunneled GET must have carried bytes both ways: only the mocked upstream body proves it.
    expect(response).toContain('{"data":[]}');
    expect(upstreamRequests.length).toBe(1);
    expect(upstreamRequests[0]!.url).toBe("http://8.8.4.4:8000/v1/models"); // pinned address
    expect(upstreamRequests[0]!.host).toBe(`${HOST}:8000`);
    expect(upstreamRequests[0]!.authorization).toBe("Bearer real-secret-value");
  } finally {
    await proxy.close();
    forgetWorkspaceSecretContext(workspaceId);
    await rm(directory, { recursive: true, force: true });
  }
});
