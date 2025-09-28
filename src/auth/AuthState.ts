// AuthState.ts - Sistema de autenticação baseado no padrão Baileys
import { promises as fs } from 'fs';
import { join } from 'path';
import { Mutex } from 'async-mutex';
import { Logger } from '../utils/Logger';
import { Curve25519 } from '../crypto/Curve25519';
import { randomBytes } from 'crypto';

// Interfaces para o estado de autenticação
export interface AuthenticationCreds {
  noiseKey: {
    private: Uint8Array;
    public: Uint8Array;
  };
  pairingEphemeralKeyPair: {
    private: Uint8Array;
    public: Uint8Array;
  };
  signedIdentityKey: {
    private: Uint8Array;
    public: Uint8Array;
  };
  signedPreKey: {
    keyPair: {
      private: Uint8Array;
      public: Uint8Array;
    };
    signature: Uint8Array;
    keyId: number;
  };
  registrationId: number;
  advSecretKey: string;
  processedHistoryMessages: any[];
  nextPreKeyId: number;
  firstUnuploadedPreKeyId: number;
  accountSyncCounter: number;
  accountSettings: {
    unarchiveChats: boolean;
  };
  registered: boolean;
  pairingCode?: string;
  lastPropHash?: string;
  routingInfo?: any;
}

export interface SignalKeyStore {
  get: (type: string, ids: string[]) => Promise<{ [id: string]: any }>;
  set: (data: { [type: string]: { [id: string]: any } }) => Promise<void>;
}

export interface AuthenticationState {
  creds: AuthenticationCreds;
  keys: SignalKeyStore;
}

// Utilitários para serialização de Buffer
export class BufferJSON {
  static replacer(key: string, value: any): any {
    if (value instanceof Uint8Array || value instanceof Buffer) {
      return {
        type: 'Buffer',
        data: Array.from(value)
      };
    }
    return value;
  }

  static reviver(key: string, value: any): any {
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
      return new Uint8Array(value.data);
    }
    return value;
  }
}

// Geração de ID de registro
function generateRegistrationId(): number {
  return Math.floor(Math.random() * 16777215) + 1;
}

// Inicialização das credenciais
export function initAuthCreds(): AuthenticationCreds {
  const identityKey = Curve25519.generateKeyPair();
  
  return {
    noiseKey: Curve25519.generateKeyPair(),
    pairingEphemeralKeyPair: Curve25519.generateKeyPair(),
    signedIdentityKey: identityKey,
    signedPreKey: {
      keyPair: Curve25519.generateKeyPair(),
      signature: new Uint8Array(64), // Placeholder - seria assinado com identityKey
      keyId: 1
    },
    registrationId: generateRegistrationId(),
    advSecretKey: randomBytes(32).toString('base64'),
    processedHistoryMessages: [],
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: {
      unarchiveChats: false
    },
    registered: false,
    pairingCode: undefined,
    lastPropHash: undefined,
    routingInfo: undefined
  };
}

// Mapa de locks por arquivo para evitar condições de corrida
const fileLocks = new Map<string, Mutex>();

// Obter ou criar mutex para um arquivo específico
function getFileLock(path: string): Mutex {
  let mutex = fileLocks.get(path);
  if (!mutex) {
    mutex = new Mutex();
    fileLocks.set(path, mutex);
  }
  return mutex;
}

// Implementação do sistema de autenticação multi-arquivo
export async function useMultiFileAuthState(folder: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  // Logger é uma classe estática, não precisa de getInstance()

  // Função para escrever dados
  const writeData = async (data: any, file: string): Promise<void> => {
    const filePath = join(folder, fixFileName(file));
    const mutex = getFileLock(filePath);
    
    return mutex.acquire().then(async (release) => {
      try {
        await fs.writeFile(filePath, JSON.stringify(data, BufferJSON.replacer, 2));
        Logger.debug(`Dados salvos em: ${file}`);
      } catch (error) {
        Logger.error(`Erro ao salvar ${file}:`, error);
        throw error;
      } finally {
        release();
      }
    });
  };

  // Função para ler dados
  const readData = async (file: string): Promise<any> => {
    try {
      const filePath = join(folder, fixFileName(file));
      const mutex = getFileLock(filePath);
      
      const data = await mutex.acquire().then(async (release) => {
        try {
          return await fs.readFile(filePath, { encoding: 'utf-8' });
        } finally {
          release();
        }
      });

      return JSON.parse(data, BufferJSON.reviver);
    } catch (error) {
      Logger.debug(`Arquivo não encontrado ou erro ao ler: ${file}`);
      return null;
    }
  };

  // Função para remover dados
  const removeData = async (file: string): Promise<void> => {
    try {
      const filePath = join(folder, fixFileName(file));
      const mutex = getFileLock(filePath);
      
      await mutex.acquire().then(async (release) => {
        try {
          await fs.unlink(filePath);
          Logger.debug(`Arquivo removido: ${file}`);
        } finally {
          release();
        }
      });
    } catch (error) {
      // Ignorar erros de arquivo não encontrado
      Logger.debug(`Erro ao remover arquivo ${file}:`, error);
    }
  };

  // Verificar/criar diretório
  try {
    const folderInfo = await fs.stat(folder);
    if (!folderInfo.isDirectory()) {
      throw new Error(`Encontrado algo que não é um diretório em ${folder}`);
    }
  } catch (error) {
    await fs.mkdir(folder, { recursive: true });
    Logger.info(`Diretório de autenticação criado: ${folder}`);
  }

  // Função para corrigir nomes de arquivo
  const fixFileName = (file: string): string => {
    return file?.replace(/\//g, '__')?.replace(/:/g, '-');
  };

  // Carregar ou inicializar credenciais
  let creds: AuthenticationCreds;
  try {
    creds = await readData('creds.json') || initAuthCreds();
    Logger.info('Credenciais carregadas com sucesso');
  } catch (error) {
    Logger.warn('Erro ao carregar credenciais, inicializando novas:', error);
    creds = initAuthCreds();
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const data: { [id: string]: any } = {};
          
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}.json`);
            if (type === 'app-state-sync-key' && value) {
              // Reconstruir objeto protobuf se necessário
              // value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value) {
              data[id] = value;
            }
          }));
          
          return data;
        },
        
        set: async (data: { [type: string]: { [id: string]: any } }) => {
          const tasks: Promise<void>[] = [];
          
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              
              if (value) {
                tasks.push(writeData(value, file));
              } else {
                tasks.push(removeData(file));
              }
            }
          }
          
          await Promise.all(tasks);
          Logger.debug(`Chaves atualizadas: ${Object.keys(data).join(', ')}`);
        }
      }
    },
    
    saveCreds: async () => {
      await writeData(creds, 'creds.json');
      Logger.debug('Credenciais salvas');
    }
  };
}

// Implementação de fallback para sessões corrompidas
export async function validateAuthState(authState: AuthenticationState): Promise<boolean> {
  try {
    // Verificar se as credenciais básicas existem
    if (!authState.creds) {
      Logger.warn('Credenciais ausentes no estado de autenticação');
      return false;
    }

    const { creds } = authState;
    
    // Verificar campos obrigatórios
    const requiredFields = [
      'noiseKey',
      'signedIdentityKey', 
      'registrationId',
      'advSecretKey'
    ];

    for (const field of requiredFields) {
      if (!creds[field as keyof AuthenticationCreds]) {
        Logger.warn(`Campo obrigatório ausente: ${field}`);
        return false;
      }
    }

    // Verificar se as chaves têm o formato correto
    if (!creds.noiseKey.private || !creds.noiseKey.public) {
      Logger.warn('Chave noise inválida');
      return false;
    }

    if (!creds.signedIdentityKey.private || !creds.signedIdentityKey.public) {
      Logger.warn('Chave de identidade inválida');
      return false;
    }

    Logger.info('Estado de autenticação validado com sucesso');
    return true;
  } catch (error) {
    Logger.error('Erro ao validar estado de autenticação:', error);
    return false;
  }
}

// Limpar estado de autenticação corrompido
export async function clearCorruptedAuthState(folder: string): Promise<void> {
  try {
    const files = await fs.readdir(folder);
    const deletePromises = files.map(file => 
      fs.unlink(join(folder, file)).catch(() => {})
    );
    
    await Promise.all(deletePromises);
    Logger.info(`Estado de autenticação corrompido limpo: ${folder}`);
  } catch (error) {
    Logger.error('Erro ao limpar estado corrompido:', error);
  }
}