import RFB from "@novnc/novnc";

const screen = document.querySelector<HTMLElement>("#screen");
const status = document.querySelector<HTMLElement>("#status");
const sessionId = location.pathname.split("/")[2];
const token = new URL(location.href).searchParams.get("token");

if (
  screen === null ||
  status === null ||
  sessionId === undefined ||
  token === null
) {
  if (status !== null) status.textContent = "此维护入口已失效。";
} else {
  const endpoint = new URL(`/human-sessions/${sessionId}/ws`, location.href);
  endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  endpoint.searchParams.set("token", token);
  const viewer = new RFB(screen, endpoint.href);
  viewer.focusOnClick = true;
  viewer.resizeSession = false;
  viewer.scaleViewport = true;
  viewer.addEventListener("connect", () => {
    status.textContent = "已连接，可以操作浏览器。";
  });
  viewer.addEventListener("disconnect", () => {
    status.textContent = "连接已结束，请回到终端查看会话状态。";
  });
}
