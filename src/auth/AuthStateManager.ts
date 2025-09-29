// AuthStateManager.ts - Gerenciador de estado de autenticação

import { randomBytes } from 'crypto';
import { Curve } from '../crypto/Curve25519';
import { Logger } from '../utils/Logger';
import * as fs from 'fs';
import * as path from 'path';
import { Mutex } from 'async-mutex';
import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { BufferJSON } from '../utils/BufferJSON';

/**
 * Interface para credenciais de autenticação (compatível com Baileys)
 */
export interface AuthenticationCreds {
  noiseKey: KeyPair;
  pairingEphemeralKeyPair: KeyPair;
  signedIdentityKey: KeyPair;
  signedPreKey: SignedKeyPair;
  registrationId: number;
  advSecretKey: string;
  nextPreKeyId: number;
  firstUnuploadedPreKeyId: number;
  serverHasPreKeys: boolean;
  // Campos obrigatórios seguindo padrão Baileys
  processedHistoryMessages: any[];
  accountSyncCounter: number;
  accountSettings: {
    unarchiveChats: boolean;
  };
  registered: boolean;
  pairingCode?: string;
  lastPropHash?: string;
  routingInfo?: any;
  // Campos opcionais
  account?: {
    details: string;
    accountSignatureKey: string;
    accountSignature: string;
    deviceSignature: string;
  };
  me?: {
    id: string;
    name?: string;
    lid?: string;
  };
  signalIdentities?: SignalIdentity[];
  myAppStateKeyId?: string;
  lastAccountSyncTimestamp?: number;
  platform?: string;
}

/**
 * Interface para par de chaves
 */
export interface KeyPair {
  private: Uint8Array;
  public: Uint8Array;
}

/**
 * Interface para par de chaves assinado
 */
export interface SignedKeyPair {
  keyId: number;
  keyPair: KeyPair;
  signature: Uint8Array;
}

/**
 * Interface para identidade Signal
 */
export interface SignalIdentity {
  identifier: {
    name: string;
    deviceId: number;
  };
  identifierKey: Uint8Array;
}

/**
 * Interface para chaves Signal Protocol (compatível com Baileys)
 */
export interface SignalDataTypeMap {
  'pre-key': {
    keyId: number;
    public: Uint8Array;
    private: Uint8Array;
  };
  'session': {
    id: string;
    session: Uint8Array;
  };
  'sender-key': {
    groupId: string;
    senderId: string;
    senderKey: Uint8Array;
  };
  'app-state-sync-key': {
    keyId: string;
    keyData: Uint8Array;
  };
  'app-state-sync-version': {
    version: number;
    hash: Uint8Array;
  };
  'sender-key-memory': any;
}

/**
 * Interface para armazenamento de chaves Signal (compatível com Baileys)
 */
export interface SignalKeyStore {
  get: (type: string, ids: string[]) => Promise<{ [id: string]: any }>;
  set: (data: { [type: string]: { [id: string]: any } }) => Promise<void>;
}

/**
 * Interface para estado de autenticação completo (compatível com Baileys)
 */
export interface AuthenticationState {
  creds: AuthenticationCreds;
  keys: SignalKeyStore;
}

/**
 * Gerenciador de estado de autenticação
 */
export class AuthStateManager {
  private static readonly SESSIONS_DIR = path.join(process.cwd(), 'sessions');
  private static readonly CREDS_FILE = 'creds.json';
  private static readonly KEYS_FILE = 'keys.json';
  
  private instanceId: string;
  private sessionPath: string;
  private credsPath: string;
  private keysPath: string;
  
  // Cache em memória para as chaves
  private keysCache: Map<string, any> = new Map();
  
  constructor(instanceId: string) {
    this.instanceId = instanceId;
    this.sessionPath = path.join(AuthStateManager.SESSIONS_DIR, instanceId);
    this.credsPath = path.join(this.sessionPath, AuthStateManager.CREDS_FILE);
    this.keysPath = path.join(this.sessionPath, AuthStateManager.KEYS_FILE);
    
    this.ensureSessionDirectory();
  }
  
  /**
   * Inicializa um novo estado de autenticação
   */
  public async initAuthState(): Promise<AuthenticationState> {
    Logger.info(`🔐 Inicializando novo estado de autenticação para: ${this.instanceId}`);
    
    const creds = this.generateAuthCreds();
    const keys = this.createKeysStore();
    
    const authState: AuthenticationState = {
      creds,
      keys
    };
    
    // Salva o estado inicial
    await this.saveCreds(creds);
    await this.saveKeys({});
    
    Logger.info(`✅ Estado de autenticação inicializado para: ${this.instanceId}`);
    return authState;
  }
  
  /**
   * Carrega estado de autenticação existente
   */
  public async loadAuthState(): Promise<AuthenticationState | null> {
    try {
      const creds = await this.loadCreds();
      if (!creds) {
        return null;
      }
      
      const keys = this.createKeysStore();
      await this.loadKeysToCache();
      
      Logger.info(`📂 Estado de autenticação carregado para: ${this.instanceId}`);
      
      return {
        creds,
        keys
      };
    } catch (error) {
      Logger.error(`❌ Erro ao carregar estado de autenticação para ${this.instanceId}:`, error);
      return null;
    }
  }
  
  /**
   * Salva as credenciais
   */
  public async saveCreds(creds: AuthenticationCreds): Promise<void> {
    try {
      this.ensureSessionDirectory();
      const serializedCreds = this.serializeCreds(creds);
      await fs.promises.writeFile(this.credsPath, JSON.stringify(serializedCreds, null, 2));
      Logger.debug(`💾 Credenciais salvas para: ${this.instanceId}`);
    } catch (error) {
      Logger.error(`❌ Erro ao salvar credenciais para ${this.instanceId}:`, error);
      throw error;
    }
  }
  
  /**
   * Carrega as credenciais
   */
  public async loadCreds(): Promise<AuthenticationCreds | null> {
    try {
      if (!fs.existsSync(this.credsPath)) {
        return null;
      }
      const data = JSON.parse(await fs.promises.readFile(this.credsPath, 'utf-8'));
      return this.deserializeCreds(data);
    } catch (error) {
      Logger.error(`❌ Erro ao carregar credenciais para ${this.instanceId}:`, error);
      return null;
    }
  }

  private async saveKeys(keys: any): Promise<void> {
    try {
      await fs.promises.writeFile(this.keysPath, JSON.stringify(keys, null, 2));
    } catch (error) {
      Logger.error(`❌ Erro ao salvar chaves para ${this.instanceId}:`, error);
      throw error;
    }
  }

  private async loadKeysToCache(): Promise<void> {
    try {
      if (!fs.existsSync(this.keysPath)) {
        return;
      }
      const data = JSON.parse(await fs.promises.readFile(this.keysPath, 'utf-8'));
      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries as any)) {
          this.keysCache.set(`${type}:${id}`, value);
        }
      }
    } catch (error) {
      Logger.error(`❌ Erro ao carregar chaves para ${this.instanceId}:`, error);
    }
  }

  private createKeysStore(): SignalKeyStore {
    return {
      get: async (type: string, ids: string[]) => {
        const result: { [id: string]: any } = {};
        for (const id of ids) {
          result[id] = this.keysCache.get(`${type}:${id}`) || null;
        }
        return result;
      },
      set: async (data: { [type: string]: { [id: string]: any } }) => {
        for (const [type, typeData] of Object.entries(data)) {
          for (const [id, value] of Object.entries(typeData)) {
            this.keysCache.set(`${type}:${id}`, value);
          }
        }
        await this.debouncedSaveKeys();
      }
    };
  }

  private saveKeysTimeout?: NodeJS.Timeout;
  private async debouncedSaveKeys(): Promise<void> {
    if (this.saveKeysTimeout) {
      clearTimeout(this.saveKeysTimeout);
    }
    this.saveKeysTimeout = setTimeout(async () => {
      const data: any = {};
      for (const [key, value] of this.keysCache.entries()) {
        const [type, id] = key.split(':');
        if (!data[type]) data[type] = {};
        data[type][id] = value;
      }
      await this.saveKeys(data);
    }, 250);
  }

  private generateAuthCreds(): AuthenticationCreds {
    // Gera chaves usando a Curve util (seguindo padrão Baileys)
    const noiseKey = Curve.generateKeyPair();
    const pairingEphemeralKeyPair = Curve.generateKeyPair();
    const signedIdentityKey = Curve.generateKeyPair();

    // Gera signed prekey corretamente (seguindo padrão Baileys)
    const keyId = 1; // Baileys usa keyId = 1 para signedPreKey inicial
    const signedPreKey = this.generateSignedKeyPair(signedIdentityKey, keyId);

    const registrationId = this.generateRegistrationId();

    const creds: AuthenticationCreds = {
      noiseKey,
      pairingEphemeralKeyPair,
      signedIdentityKey,
      signedPreKey,
      registrationId,
      advSecretKey: Buffer.from(randomBytes(32)).toString('base64'),
      nextPreKeyId: 1,
      firstUnuploadedPreKeyId: 1,
      serverHasPreKeys: false,
      // Campos adicionais seguindo padrão Baileys
      processedHistoryMessages: [],
      accountSyncCounter: 0,
      accountSettings: {
        unarchiveChats: false
      },
      registered: false,
      pairingCode: undefined,
      lastPropHash: undefined
    };

    return creds;
  }

  private generateSignedKeyPair(identityKey: KeyPair, keyId: number): SignedKeyPair {
    const preKey = Curve.generateKeyPair();
    const pubKey = Buffer.concat([Buffer.from([0x05]), Buffer.from(preKey.public)]);
    const signature = Curve.sign(identityKey.private, pubKey);
    return {
      keyId,
      keyPair: preKey,
      signature
    };
  }

  private generateRegistrationId(): number {
    return Uint16Array.from(randomBytes(2))[0]! & 16383;
  }

  private serializeCreds(creds: AuthenticationCreds): any {
    return {
      noiseKey: {
        private: Buffer.from(creds.noiseKey.private).toString('base64'),
        public: Buffer.from(creds.noiseKey.public).toString('base64')
      },
      pairingEphemeralKeyPair: {
        private: Buffer.from(creds.pairingEphemeralKeyPair.private).toString('base64'),
        public: Buffer.from(creds.pairingEphemeralKeyPair.public).toString('base64')
      },
      signedIdentityKey: {
        private: Buffer.from(creds.signedIdentityKey.private).toString('base64'),
        public: Buffer.from(creds.signedIdentityKey.public).toString('base64')
      },
      signedPreKey: {
        keyId: creds.signedPreKey.keyId,
        private: Buffer.from(creds.signedPreKey.keyPair.private).toString('base64'),
        public: Buffer.from(creds.signedPreKey.keyPair.public).toString('base64'),
        signature: Buffer.from(creds.signedPreKey.signature).toString('base64')
      },
      registrationId: creds.registrationId,
      advSecretKey: creds.advSecretKey,
      nextPreKeyId: creds.nextPreKeyId,
      firstUnuploadedPreKeyId: creds.firstUnuploadedPreKeyId,
      serverHasPreKeys: creds.serverHasPreKeys,
      account: creds.account || null,
      me: creds.me || null,
      signalIdentities: creds.signalIdentities || [],
      myAppStateKeyId: creds.myAppStateKeyId || null,
      lastAccountSyncTimestamp: creds.lastAccountSyncTimestamp || null,
      platform: creds.platform || null
    };
  }

  private deserializeCreds(data: any): AuthenticationCreds {
    const parseKeyPair = (obj: any): KeyPair => ({
      private: Buffer.from(obj.private, 'base64'),
      public: Buffer.from(obj.public, 'base64')
    });

    const parseSigned = (obj: any): SignedKeyPair => ({
      keyId: obj.keyId,
      keyPair: {
        private: Buffer.from(obj.private, 'base64'),
        public: Buffer.from(obj.public, 'base64')
      },
      signature: Buffer.from(obj.signature, 'base64')
    });

    return {
      noiseKey: parseKeyPair(data.noiseKey),
      pairingEphemeralKeyPair: parseKeyPair(data.pairingEphemeralKeyPair),
      signedIdentityKey: parseKeyPair(data.signedIdentityKey),
      signedPreKey: parseSigned(data.signedPreKey),
      registrationId: data.registrationId,
      advSecretKey: data.advSecretKey,
      nextPreKeyId: data.nextPreKeyId,
      firstUnuploadedPreKeyId: data.firstUnuploadedPreKeyId,
      serverHasPreKeys: data.serverHasPreKeys,
      // Campos obrigatórios seguindo padrão Baileys
      processedHistoryMessages: data.processedHistoryMessages || [],
      accountSyncCounter: data.accountSyncCounter || 0,
      accountSettings: data.accountSettings || { unarchiveChats: false },
      registered: data.registered || false,
      // Campos opcionais
      pairingCode: data.pairingCode,
      lastPropHash: data.lastPropHash,
      account: data.account || undefined,
      me: data.me || undefined,
      signalIdentities: data.signalIdentities || undefined,
      myAppStateKeyId: data.myAppStateKeyId || undefined,
      lastAccountSyncTimestamp: data.lastAccountSyncTimestamp || undefined,
      platform: data.platform || undefined
    };
  }

  public async removeAuthState(): Promise<void> {
    try {
      if (fs.existsSync(this.sessionPath)) {
        await fs.promises.rm(this.sessionPath, { recursive: true, force: true });
        Logger.info(`🗑️ Sessão removida: ${this.instanceId}`);
      }
    } catch (error) {
      Logger.error(`❌ Erro ao remover sessão ${this.instanceId}:`, error);
    }
  }

  public hasAuthState(): boolean {
    return fs.existsSync(this.credsPath);
  }

  /**
   * Implementação do useMultiFileAuthState compatível com Baileys original
   */
  public async useMultiFileAuthState(folder: string): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }> {
    // Mapa de mutexes para controle de acesso aos arquivos
    const fileLocks = new Map<string, Mutex>();
    
    // Obtém ou cria um mutex para um caminho específico
    const getFileLock = (path: string): Mutex => {
      let mutex = fileLocks.get(path);
      if (!mutex) {
        mutex = new Mutex();
        fileLocks.set(path, mutex);
      }
      return mutex;
    };
    
    // Função para escrever dados em arquivo
    const writeData = async (data: any, file: string) => {
      const filePath = path.join(folder, this.fixFileName(file)!);
      const mutex = getFileLock(filePath);
      
      return mutex.acquire().then(async release => {
        try {
          await writeFile(filePath, JSON.stringify(data, BufferJSON.replacer));
        } finally {
          release();
        }
      });
    };
    
    // Função para ler dados de arquivo
    const readData = async (file: string) => {
      try {
        const filePath = path.join(folder, this.fixFileName(file)!);
        const mutex = getFileLock(filePath);
        
        return await mutex.acquire().then(async release => {
          try {
            const data = await readFile(filePath, { encoding: 'utf-8' });
            return JSON.parse(data, BufferJSON.reviver);
          } finally {
            release();
          }
        });
      } catch (error) {
        return null;
      }
    };
    
    // Função para remover dados
    const removeData = async (file: string) => {
      try {
        const filePath = path.join(folder, this.fixFileName(file)!);
        const mutex = getFileLock(filePath);
        
        return mutex.acquire().then(async release => {
          try {
            await unlink(filePath);
          } catch {
          } finally {
            release();
          }
        });
      } catch {}
    };
    
    // Verifica se a pasta existe, se não, cria
    const folderInfo = await stat(folder).catch(() => {});
    if (folderInfo) {
      if (!folderInfo.isDirectory()) {
        throw new Error(
          `found something that is not a directory at ${folder}, either delete it or specify a different location`
        );
      }
    } else {
      await mkdir(folder, { recursive: true });
    }
    
    // Carrega ou inicializa credenciais
    const creds: AuthenticationCreds = (await readData('creds.json')) || this.initAuthCreds();
    
    return {
      state: {
        creds,
        keys: {
          get: async (type: string, ids: string[]) => {
            const data: { [id: string]: any } = {};
            await Promise.all(
              ids.map(async id => {
                const value = await readData(`${type}-${id}.json`);
                // Tratamento especial para app-state-sync-key se necessário
                if (type === 'app-state-sync-key' && value) {
                  // Aqui poderia ter tratamento específico do proto se necessário
                  // value = proto.Message.AppStateSyncKeyData.create(value);
                }
                data[id] = value;
              })
            );
            return data;
          },
          set: async (data: { [type: string]: { [id: string]: any } }) => {
            const tasks: Promise<void>[] = [];
            for (const category in data) {
              for (const id in data[category]) {
                const value = data[category][id];
                const file = `${category}-${id}.json`;
                tasks.push(value ? writeData(value, file) : removeData(file));
              }
            }
            await Promise.all(tasks);
          }
        }
      },
      saveCreds: async () => {
        return writeData(creds, 'creds.json');
      }
    };
  }
  
  /**
   * Corrige nomes de arquivo para serem compatíveis com sistema de arquivos
   */
  private fixFileName(file?: string): string | undefined {
    return file?.replace(/\//g, '__')?.replace(/:/g, '-');
  }
  
  /**
   * Inicializa credenciais seguindo exatamente o padrão Baileys
   */
  public initAuthCreds(): AuthenticationCreds {
    const identityKey = Curve.generateKeyPair();
    return {
      noiseKey: Curve.generateKeyPair(),
      pairingEphemeralKeyPair: Curve.generateKeyPair(),
      signedIdentityKey: identityKey,
      signedPreKey: this.generateSignedKeyPair(identityKey, 1),
      registrationId: this.generateRegistrationId(),
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
      routingInfo: undefined,
      serverHasPreKeys: false
    };
  }
  
  public async createBaileysCompatibleAuthState(): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }> {
    const existing = await this.loadAuthState();
    const state = existing || (await this.initAuthState());
    const saveCreds = async () => {
      await this.saveCreds(state.creds);
    };
    return { state, saveCreds };
  }

  public async updateCreds(credsUpdate: Partial<AuthenticationCreds>): Promise<void> {
    const existing = await this.loadCreds();
    if (!existing) return;
    const updated = { ...existing, ...credsUpdate } as AuthenticationCreds;
    await this.saveCreds(updated);
  }

  private ensureSessionDirectory(): void {
    if (!fs.existsSync(AuthStateManager.SESSIONS_DIR)) {
      fs.mkdirSync(AuthStateManager.SESSIONS_DIR, { recursive: true });
    }
    if (!fs.existsSync(this.sessionPath)) {
      fs.mkdirSync(this.sessionPath, { recursive: true });
    }
  }
}