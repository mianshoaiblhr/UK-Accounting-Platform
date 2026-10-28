export type CtRulesCall = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, body?: object) => Promise<{ status: number; body: any }>;
export function importCtRules(call: CtRulesCall, pack: unknown): Promise<{ rules: { id: string; kind: string; effectiveFrom: string; verificationStatus: string }[] }>;
