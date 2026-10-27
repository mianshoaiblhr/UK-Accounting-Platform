export type RuleCall = (method: 'get' | 'post' | 'put' | 'patch', path: string, body?: object) => Promise<{ status: number; body: any }>;
export function importDeadlineRules(call: RuleCall, pack: unknown): Promise<{ rules: { id: string; kind: string; legalForms: string[]; verificationStatus: string }[] }>;
