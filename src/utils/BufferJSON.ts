/**
 * Utilitário para serialização/deserialização de Buffers em JSON
 * Compatível com Baileys original
 */
export const BufferJSON = {
  replacer: (k: any, value: any) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
      return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') };
    }
    return value;
  },
  
  reviver: (_: any, value: any) => {
    if (typeof value === 'object' && !!value && (value.buffer === true || value.type === 'Buffer')) {
      const val = value.data || value.value;
      return typeof val === 'string' ? Buffer.from(val, 'base64') : Buffer.from(val || []);
    }
    return value;
  }
};