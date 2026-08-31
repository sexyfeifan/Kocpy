import http from "node:http";
import os from "node:os";
import { randomBytes } from "node:crypto";
import type { BackupTask, ProjectConfig } from "./types";
type Snapshot = { projects: ProjectConfig[]; tasks: BackupTask[] };
export class LanProjectIndex {
  private server?: http.Server;
  private token = "";
  private startedAt = 0;
  constructor(public snapshot: () => Snapshot | Promise<Snapshot>) {}
  async start(port = 47821) {
    if (this.server) return this.status();
    this.token = randomBytes(18).toString("base64url");
    this.startedAt = Date.now();
    const server = http.createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      if (request.headers.authorization !== `Bearer ${this.token}`) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (!request.url?.startsWith("/index")) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      try {
        const data = await this.snapshot();
        response.end(
          JSON.stringify({
            schema: 1,
            generatedAt: Date.now(),
            projects: data.projects.map((project) => ({
              id: project.id,
              name: project.name,
              devices: project.devices,
              shootingDateStart: project.shootingDateStart,
              shootingDateEnd: project.shootingDateEnd,
              status: project.status,
              requiredCopies: project.requiredCopies,
            })),
            tasks: data.tasks.map((task) => ({
              id: task.id,
              projectId: task.projectId,
              name: task.name,
              shootingDate: task.shootingDate,
              devices: task.devices,
              status: task.status,
              totalFiles: task.totalFiles,
              totalBytes: task.totalBytes,
              provenance: task.provenance,
              destinations: task.destinations.map((item) => ({
                label: item.label,
                verified: item.verified,
                volumeName: item.volumeName,
              })),
            })),
          }),
        );
      } catch (error) {
        response.statusCode = 500;
        response.end(
          JSON.stringify({ error: "snapshot_failed", message: String(error) }),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    return this.status();
  }
  stop() {
    this.server?.close();
    this.server = undefined;
    this.token = "";
    return this.status();
  }
  status() {
    const addresses = Object.values(os.networkInterfaces())
        .flat()
        .filter((item) => item?.family === "IPv4" && !item.internal)
        .map((item) => item!.address),
      address = this.server?.address();
    return {
      active: Boolean(this.server),
      port: typeof address === "object" && address ? address.port : 47821,
      addresses,
      token: this.token,
      startedAt: this.startedAt,
    };
  }
}

/** Read-only LAN client. Tokens never enter URLs, logs, persisted settings, or redirects. */
export async function readLanProjectIndex(address: string, token: string) {
  const url = new URL(address);
  const octets = url.hostname.split(".").map(Number);
  const local =
    url.hostname === "localhost" ||
    (octets.length === 4 &&
      octets.every(
        (item) => Number.isInteger(item) && item >= 0 && item <= 255,
      ) &&
      (octets[0] === 127 ||
        octets[0] === 10 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 169 && octets[1] === 254)));
  if (
    url.protocol !== "http:" ||
    !local ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/index"
  )
    throw new Error(
      "请输入同一局域网工作站显示的 http://内网IP:端口/index 地址",
    );
  if (!token.trim() || /[\r\n]/.test(token) || token.length > 200)
    throw new Error("请填写有效访问令牌");
  return new Promise<{ projects: any[]; tasks: any[]; generatedAt: number }>(
    (resolve, reject) => {
      const request = http.get(
        url,
        { headers: { Authorization: "Bearer " + token.trim() } },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(
              new Error(
                response.statusCode === 401
                  ? "令牌无效或已过期，请从对方工作站重新获取"
                  : "共享索引读取失败：" + response.statusCode,
              ),
            );
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) {
              request.destroy(
                new Error("共享索引超过 8 MiB，请缩小共享项目范围"),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (
                data.schema !== 1 ||
                !Array.isArray(data.projects) ||
                !Array.isArray(data.tasks)
              )
                throw new Error("不是 Kocpy 只读索引");
              resolve({
                projects: data.projects,
                tasks: data.tasks,
                generatedAt: data.generatedAt,
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.setTimeout(8000, () =>
        request.destroy(new Error("连接超时，请检查两台工作站网络及防火墙")),
      );
      request.on("error", reject);
    },
  );
}
