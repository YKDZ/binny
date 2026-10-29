import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

type GateState = {
  started: boolean;
  released: boolean;
  touches: number;
  lastTouchAt?: number;
  unloadedAt?: number;
};

const port = Number(process.env.BINNY19_SOURCE_PORT ?? "8081");
const loginSubmissions: { readonly maxAge: number; readonly at: number }[] = [];
const loginPageViews: number[] = [];
const authenticatedProtectedVisits: number[] = [];
const gates = new Map<string, GateState>();

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": contentType,
  });
  response.end(body);
}

function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      value += chunk;
    });
    request.once("end", () => resolve(value));
    request.once("error", reject);
  });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://browser-session-source");
    if (url.pathname === "/__control/metrics" && request.method === "GET") {
      send(
        response,
        200,
        "application/json; charset=utf-8",
        JSON.stringify({
          loginSubmissions,
          loginPageViews,
          authenticatedProtectedVisits,
          gates: Object.fromEntries(gates),
        }),
      );
      return;
    }
    const gateMatch =
      /^\/__control\/gates\/([0-9a-f-]+)(?:\/(release))?$/iu.exec(url.pathname);
    if (gateMatch !== null && request.method === "POST") {
      const gateId = gateMatch[1]!;
      if (gateMatch[2] === "release") {
        const gate = gates.get(gateId);
        if (gate === undefined) {
          send(response, 404, "text/plain; charset=utf-8", "Gate not found.");
          return;
        }
        gate.released = true;
      } else {
        gates.set(gateId, {
          started: false,
          released: false,
          touches: 0,
        });
      }
      send(response, 204, "text/plain; charset=utf-8", "");
      return;
    }
    if (url.pathname === "/login" && request.method === "GET") {
      const maxAge = Number(url.searchParams.get("lifetime") ?? "600");
      loginPageViews.push(Date.now());
      send(
        response,
        200,
        "text/html; charset=utf-8",
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>受控登录</title><body><h1>受控登录</h1><form action="/login" method="post"><label>用户名<input name="username" autocomplete="off" autofocus></label><label>密码<input name="password" type="password" autocomplete="off"></label><input type="hidden" name="lifetime" value="${String(maxAge)}"><button type="submit">登录</button></form></body></html>`,
      );
      return;
    }
    if (url.pathname === "/login" && request.method === "POST") {
      const form = new URLSearchParams(await body(request));
      const maxAge = Number(form.get("lifetime"));
      if (
        form.get("username") !== "binny19-user" ||
        form.get("password") !== "browser-session" ||
        !Number.isSafeInteger(maxAge) ||
        maxAge < 1
      ) {
        send(response, 401, "text/plain; charset=utf-8", "登录信息无效。");
        return;
      }
      loginSubmissions.push({ maxAge, at: Date.now() });
      response.writeHead(303, {
        "cache-control": "no-store",
        location: "/protected",
        "set-cookie": `binny19_session=valid; Path=/; HttpOnly; Max-Age=${String(maxAge)}; SameSite=Lax`,
      });
      response.end();
      return;
    }
    if (url.pathname === "/protected") {
      if (
        !(request.headers.cookie ?? "")
          .split(";")
          .some((part) => part.trim() === "binny19_session=valid")
      ) {
        response.writeHead(302, {
          "cache-control": "no-store",
          location: "/login",
        });
        response.end();
        return;
      }
      authenticatedProtectedVisits.push(Date.now());
      const gateId = url.searchParams.get("gate");
      const pageScript =
        gateId === null
          ? ""
          : `<script>
              const gateId = ${JSON.stringify(gateId)};
              window.addEventListener("unload", () => navigator.sendBeacon("/unload?gate=" + encodeURIComponent(gateId)));
              setInterval(async () => {
                fetch("/touch?gate=" + encodeURIComponent(gateId), { cache: "no-store" });
                const state = await fetch("/gate-state?gate=" + encodeURIComponent(gateId), { cache: "no-store" });
                if (await state.text() === "released") window.binny19GateReleased = true;
              }, 100);
              window.binny19GateReleased = false;
            </script>`;
      if (gateId !== null) {
        const gate = gates.get(gateId);
        if (gate === undefined) {
          send(
            response,
            500,
            "text/plain; charset=utf-8",
            "Gate is not registered.",
          );
          return;
        }
        gate.started = true;
      }
      send(
        response,
        200,
        "text/html; charset=utf-8",
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>受控保护页面</title><body><h1 id="protected-content">受控保护内容</h1><p>仅登录后可见。</p>${pageScript}</body></html>`,
      );
      return;
    }
    if (url.pathname === "/touch") {
      const gate = gates.get(url.searchParams.get("gate") ?? "");
      if (gate !== undefined) {
        gate.touches += 1;
        gate.lastTouchAt = Date.now();
      }
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === "/gate-state") {
      const gate = gates.get(url.searchParams.get("gate") ?? "");
      send(
        response,
        gate === undefined ? 404 : 200,
        "text/plain; charset=utf-8",
        gate?.released === true ? "released" : "waiting",
      );
      return;
    }
    if (url.pathname === "/unload") {
      const gate = gates.get(url.searchParams.get("gate") ?? "");
      if (gate !== undefined) gate.unloadedAt = Date.now();
      response.writeHead(204);
      response.end();
      return;
    }
    send(response, 404, "text/plain; charset=utf-8", "Not found.");
  } catch (error) {
    send(
      response,
      500,
      "text/plain; charset=utf-8",
      error instanceof Error ? error.message : String(error),
    );
  }
});

server.listen(port, "0.0.0.0");
process.once("SIGINT", () => server.close());
process.once("SIGTERM", () => server.close());
