export type CliCommandIdentity = {
  readonly commandName: string;
  readonly version: string;
};

export function cliCommandIdentity(manifest: {
  readonly bin: Readonly<Record<string, string>>;
  readonly version?: string;
}): CliCommandIdentity {
  const names = Object.keys(manifest.bin);
  if (names.length !== 1) {
    throw new Error("CLI 包必须声明唯一命令。");
  }
  return {
    commandName: names[0]!,
    version: manifest.version ?? "unpublished",
  };
}
