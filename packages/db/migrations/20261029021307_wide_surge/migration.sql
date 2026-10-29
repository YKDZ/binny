ALTER TABLE "bin_configurations" ADD COLUMN "browser_idle_timeout_seconds" integer DEFAULT 300;--> statement-breakpoint
-- 旧版必需浏览器可能不支持关闭后复用 profile；结构声明无法生成这项存量禁用回填。
UPDATE "bin_configurations" SET "browser_idle_timeout_seconds" = NULL WHERE "collector" #>> '{environment,browser,required}' = 'true' AND "collector" #>> '{environment,browser,profileReuseAfterRestart}' = 'false';--> statement-breakpoint
ALTER TABLE "bin_configurations" ADD CONSTRAINT "bin_configurations_browser_idle_timeout_seconds_check" CHECK ("browser_idle_timeout_seconds" between 0 and 2147483);
