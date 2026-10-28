export type TaxonomyCall = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, body?: object) => Promise<{ status: number; body: any }>;
export function importTaxonomy(call: TaxonomyCall, pack: unknown): Promise<{ versionId: string; status: string; entries: number; problems: string[] }>;
