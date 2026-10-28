import { createApiClient } from "@binny/api/client";

export async function exercisePublicApiClient(baseUrl: string) {
  const client = createApiClient(baseUrl);
  const healthResponse = await client.health.$get();
  if (healthResponse.status !== 200)
    throw new Error("健康检查返回了未声明的状态码。");
  const health = await healthResponse.json();
  if (health.status !== "ok") throw new Error("健康检查未返回在线状态。");

  const binsResponse = await client.bins.$get();
  if (binsResponse.status !== 200)
    throw new Error("bin 列表返回了未声明的状态码。");
  const { bins } = await binsResponse.json();
  return { health: health.status, binIds: bins.map(({ id }) => id) };
}
