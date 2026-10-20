export type PackCall = (method: 'get' | 'post' | 'put' | 'patch', path: string, body?: object) => Promise<{ status: number; body: any }>;
export function importPack(call: PackCall, pack: unknown): Promise<{ standardId: string; versionId: string; status: string; turnoverLineKey: string | null; lines: number; mapEntries: number; validationRules: number; disclosureRules: number; problems: string[] }>;
export function importThresholds(call: PackCall, pack: unknown): Promise<{ sets: { id: string; label: string; status: string }[] }>;
