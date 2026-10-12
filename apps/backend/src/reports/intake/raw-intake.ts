export const RAW_INTAKE = Symbol('validated-raw-intake');
export const isIntakePath = (url: string, method: string) => method === 'PUT' && /^\/api\/v1\/reports\/[0-9a-f-]{36}\/upload-attempts\/[0-9a-f-]{36}\/bytes$/.test(url);
