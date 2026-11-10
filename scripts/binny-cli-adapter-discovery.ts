import assert from "node:assert/strict";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type CliWire<T> = {
  readonly kind: string;
  readonly variant: string;
  readonly data: T;
};

type Cli = (args: readonly string[]) => Promise<ProcessResult>;

type BinActionList = {
  readonly actions: Record<string, { readonly description: string }>;
};

type BinActionDiscovery = {
  readonly actions: Record<string, Record<string, unknown>>;
};

function cliData<T>(result: ProcessResult, variant: string): T {
  assert.equal(result.code, 0, result.stderr);
  const wire = JSON.parse(result.stdout) as CliWire<T>;
  assert.equal(wire.kind, "data");
  assert.equal(wire.variant, variant);
  return wire.data;
}

export async function assertBinActionDeclarations(
  cli: Cli,
  binId: string,
  expectedManifest: Record<string, unknown>,
): Promise<void> {
  const expectedActions = expectedManifest.actions;
  assert.ok(
    typeof expectedActions === "object" &&
      expectedActions !== null &&
      !Array.isArray(expectedActions),
  );
  const entries = Object.entries(expectedActions) as [
    string,
    Record<string, unknown>,
  ][];
  const expectedSummaries = Object.fromEntries(
    entries.map(([name, declaration]) => {
      assert.ok(typeof declaration.description === "string");
      return [name, { description: declaration.description }];
    }),
  );
  const list = cliData<BinActionList>(
    await cli(["bin", "actions", binId]),
    "discovered",
  );
  assert.deepEqual(list.actions, expectedSummaries);

  for (const [name, expectedDeclaration] of entries) {
    const selected = cliData<BinActionDiscovery>(
      await cli(["bin", "actions", binId, name]),
      "discovered",
    );
    assert.deepEqual(selected.actions, { [name]: expectedDeclaration });
  }
}
