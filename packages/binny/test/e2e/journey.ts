export type CliJourneyMode = "source" | "packed";

export type CliJourneyCommand = {
  readonly name: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
};

export type CliJourneyResult = {
  readonly commandName: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CliJourneyContext = {
  readonly mode: CliJourneyMode;
  readonly packageRoot: string;
  readonly workDir: string;
};

export type CliJourney = {
  readonly name: string;
  readonly modes: readonly CliJourneyMode[];
  setup(context: CliJourneyContext): Promise<void>;
  commands(context: CliJourneyContext): readonly CliJourneyCommand[];
  assertions(options: {
    readonly context: CliJourneyContext;
    readonly results: readonly CliJourneyResult[];
  }): Promise<void>;
};
