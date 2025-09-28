import { waproto } from '@wppconnect/wa-proto';
import { AuthenticationCreds, AuthenticationState } from '../auth/AuthStateManager';
import { Curve } from '../crypto/Curve25519';

// Constantes do Baileys
const INITIAL_PREKEY_COUNT = 30;
const MIN_PREKEY_COUNT = 5;
const KEY_BUNDLE_TYPE = Buffer.from([5]);

/**
 * Gera pre-keys
 */
export const generatePreKeys = (count: number, startId: number) => {
  const preKeys: any[] = [];
  
  for (let i = 0; i < count; i++) {
    const keyId = startId + i;
    const keyPair = Curve.generateKeyPair();
    
    preKeys.push({
      keyId,
      keyPair
    });
  }
  
  return preKeys;
};

/**
 * Obtém nó de próximas pre-keys
 */
export const getNextPreKeysNode = (preKeys: any[]) => {
  const node = {
    tag: 'iq',
    attrs: {
      to: 's.whatsapp.net',
      type: 'set',
      xmlns: 'encrypt',
      id: generateMessageTag()
    },
    content: [
      {
        tag: 'registration',
        attrs: {},
        content: preKeys.map(({ keyId, keyPair }) => ({
          tag: 'key',
          attrs: {
            id: keyId.toString()
          },
          content: keyPair.public
        }))
      }
    ]
  };
  
  return node;
};

/**
 * Faz upload de pre-keys para o servidor se necessário
 */
export const uploadPreKeysToServerIfRequired = async (
  authState: AuthenticationState,
  sendNode: (node: any) => Promise<any>
) => {
  const creds = authState.creds;
  
  // Verifica quantas pre-keys existem no servidor
  const availablePreKeys = await getAvailablePreKeysOnServer(authState, sendNode);
  
  console.log(`📊 Pre-keys disponíveis no servidor: ${availablePreKeys}`);
  
  if (availablePreKeys < MIN_PREKEY_COUNT) {
    const uploadCount = INITIAL_PREKEY_COUNT - availablePreKeys;
    console.log(`📤 Fazendo upload de ${uploadCount} pre-keys...`);
    
    await uploadPreKeys(authState, sendNode, uploadCount);
  } else {
    console.log('✅ Pre-keys suficientes no servidor');
  }
};

/**
 * Obtém pre-keys disponíveis no servidor
 */
export const getAvailablePreKeysOnServer = async (
  authState: AuthenticationState,
  sendNode: (node: any) => Promise<any>
): Promise<number> => {
  try {
    const query = {
      tag: 'iq',
      attrs: {
        to: 's.whatsapp.net',
        type: 'get',
        xmlns: 'encrypt',
        id: generateMessageTag()
      },
      content: [
        {
          tag: 'count',
          attrs: {}
        }
      ]
    };
    
    const result = await sendNode(query);
    
    if (result?.content?.[0]?.attrs?.value) {
      return parseInt(result.content[0].attrs.value, 10);
    }
    
    return 0;
  } catch (error) {
    console.warn('⚠️ Erro ao obter contagem de pre-keys:', error);
    return 0;
  }
};

/**
 * Faz upload de pre-keys
 */
export const uploadPreKeys = async (
  authState: AuthenticationState,
  sendNode: (node: any) => Promise<any>,
  count: number = INITIAL_PREKEY_COUNT
) => {
  const creds = authState.creds;
  
  // Gera novas pre-keys
  const preKeys = generatePreKeys(count, creds.nextPreKeyId);
  
  // Salva as pre-keys no keystore
  const preKeyData: { [id: string]: any } = {};
  preKeys.forEach(({ keyId, keyPair }) => {
    preKeyData[keyId.toString()] = keyPair;
  });
  
  await authState.keys.set({ 'pre-key': preKeyData });
  
  // Cria o nó para upload
  const uploadNode = getNextPreKeysNode(preKeys);
  
  try {
    await sendNode(uploadNode);
    
    // Atualiza o próximo ID de pre-key
    creds.nextPreKeyId += count;
    
    console.log(`✅ Upload de ${count} pre-keys concluído`);
  } catch (error) {
    console.error('❌ Erro no upload de pre-keys:', error);
    throw error;
  }
};

/**
 * Gera signed pre-key
 */
export const generateSignedPreKey = (identityKey: any, keyId: number) => {
  const keyPair = Curve.generateKeyPair();
  const signature = Curve.sign(identityKey.private, keyPair.public);
  
  return {
    keyId,
    keyPair,
    signature
  };
};

/**
 * Gera ID de registro
 */
export const generateRegistrationId = (): number => {
  return Math.floor(Math.random() * 16777215) + 1;
};

/**
 * Gera tag de mensagem
 */
const generateMessageTag = (): string => {
  return Math.floor(Math.random() * 1000000).toString();
};

/**
 * Codifica big endian
 */
export const encodeBigEndian = (value: number, bytes: number = 4): Buffer => {
  const buffer = Buffer.allocUnsafe(bytes);
  buffer.writeUIntBE(value, 0, bytes);
  return buffer;
};

/**
 * Cria par de chaves assinado
 */
export const signedKeyPair = (identityKey: any, keyId: number) => {
  return generateSignedPreKey(identityKey, keyId);
};