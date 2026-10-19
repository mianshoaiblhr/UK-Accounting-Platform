export type PackCall = (method: 'get' | 'post' | 'put' | 'patch', path: string, body?: object) => Promise<{ status: number; body: any }>;
export function importPack(call: PackCall, pack: unknown): Promise<{ standardId: string; versionId: string; status: string; lines: number; mapEntries: number; validationRules: number; disclosureRules: number; problems: string[] }>;
