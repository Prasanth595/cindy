/** Host-owned native policy evaluation. No rule text or authority comes from the model. */
export interface PiCommandRuleEvidence {
  cwd: string;
  argv: string[];
  /** Trusted execution adapter for a script-file transport, never model input. */
  analysisArgv?: string[];
  script?: string;
}

export interface PiCommandRuleRequest {
  toolName: 'bash' | 'powershell';
  command: string;
  evidence: PiCommandRuleEvidence | null;
  workingDir: string;
  remoteHostId?: string | null;
}

export interface PiCommandRuleEvaluation {
  decision: 'allow' | 'prompt' | 'forbidden' | 'unmatched' | 'error';
  revision: string;
  /** Safe diagnostic: never rule contents or native parser output. */
  reason?: string;
  /** Re-read source/package and owner scope after every approval await. */
  isCurrent(): Promise<boolean>;
}

export type EvaluatePiCommandRules = (request: PiCommandRuleRequest) => Promise<PiCommandRuleEvaluation>;

export function parsePiCommandRuleEvidence(value: unknown): PiCommandRuleEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { cwd, argv, analysisArgv } = value as Record<string, unknown>;
  if (typeof cwd !== 'string' || !cwd || !Array.isArray(argv) || argv.length > 1024
    || !argv.every((arg) => typeof arg === 'string' && !arg.includes('\0'))) return null;
  if (analysisArgv !== undefined && (!Array.isArray(analysisArgv) || !analysisArgv.every((a) => typeof a === 'string'))) return null;
  return { cwd, argv: [...argv] as string[], ...(analysisArgv ? { analysisArgv: [...analysisArgv as string[]] } : {}) };
}
