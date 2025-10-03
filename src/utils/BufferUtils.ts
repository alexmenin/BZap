// BufferUtils.ts - Utilitários para conversão segura de Buffer/Uint8Array

/**
 * Serializa uma chave Buffer para string base64
 * @param key - Chave em formato Buffer ou Uint8Array
 * @returns String base64
 */
export function serializeKey(key: Buffer | Uint8Array): string {
  if (!key) {
    throw new Error('Chave não pode ser nula ou undefined');
  }
  
  // Garante que sempre convertemos para Buffer antes de serializar
  const buffer = Buffer.isBuffer(key) ? key : Buffer.from(key);
  return buffer.toString('base64');
}

/**
 * Deserializa uma string base64 para Buffer
 * @param stored - String base64 armazenada
 * @returns Buffer
 */
export function deserializeKey(stored: string): Buffer {
  if (!stored || typeof stored !== 'string') {
    throw new Error('Valor armazenado deve ser uma string base64 válida');
  }
  
  return Buffer.from(stored, 'base64');
}

/**
 * Garante que um valor seja um Buffer
 * @param value - Valor que pode ser Buffer, Uint8Array ou string base64
 * @returns Buffer
 */
export function ensureBuffer(value: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  
  if (typeof value === 'string') {
    return Buffer.from(value, 'base64');
  }
  
  throw new Error(`Tipo não suportado para conversão para Buffer: ${typeof value}`);
}

/**
 * Serializa um KeyPair garantindo que as chaves sejam Buffers
 * @param keyPair - Par de chaves
 * @returns Objeto serializado
 */
export function serializeKeyPair(keyPair: { private: Buffer | Uint8Array; public: Buffer | Uint8Array }) {
  return {
    private: serializeKey(keyPair.private),
    public: serializeKey(keyPair.public)
  };
}

/**
 * Deserializa um KeyPair garantindo que as chaves sejam Buffers
 * @param stored - Objeto com chaves serializadas
 * @returns KeyPair com Buffers
 */
export function deserializeKeyPair(stored: { private: string; public: string }) {
  return {
    private: deserializeKey(stored.private),
    public: deserializeKey(stored.public)
  };
}

/**
 * Serializa um SignedKeyPair
 * @param signedKeyPair - Par de chaves assinado
 * @returns Objeto serializado
 */
export function serializeSignedKeyPair(signedKeyPair: {
  keyId: number;
  keyPair: { private: Buffer | Uint8Array; public: Buffer | Uint8Array };
  signature: Buffer | Uint8Array;
}) {
  return {
    keyId: signedKeyPair.keyId,
    keyPair: serializeKeyPair(signedKeyPair.keyPair),
    signature: serializeKey(signedKeyPair.signature)
  };
}

/**
 * Deserializa um SignedKeyPair
 * @param stored - Objeto com chaves serializadas
 * @returns SignedKeyPair com Buffers
 */
export function deserializeSignedKeyPair(stored: {
  keyId: number;
  keyPair: { private: string; public: string };
  signature: string;
}) {
  return {
    keyId: stored.keyId,
    keyPair: deserializeKeyPair(stored.keyPair),
    signature: deserializeKey(stored.signature)
  };
}

/**
 * Valida se uma chave está no formato correto (Buffer)
 * @param key - Chave a ser validada
 * @param keyName - Nome da chave para mensagens de erro
 */
export function validateKeyFormat(key: any, keyName: string): void {
  if (!Buffer.isBuffer(key)) {
    throw new Error(`${keyName} deve ser um Buffer, recebido: ${typeof key}`);
  }
}

/**
 * Converte todas as chaves de um objeto para Buffer
 * @param obj - Objeto contendo chaves
 * @returns Objeto com todas as chaves convertidas para Buffer
 */
export function ensureAllKeysAreBuffers<T extends Record<string, any>>(obj: T): T {
  const result = { ...obj } as any;
  
  for (const [key, value] of Object.entries(result)) {
    if (value && (Buffer.isBuffer(value) || value instanceof Uint8Array)) {
      result[key] = ensureBuffer(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Recursivamente converte objetos aninhados
      result[key] = ensureAllKeysAreBuffers(value);
    }
  }
  
  return result as T;
}