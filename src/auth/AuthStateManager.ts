// AuthStateManager.ts - Gerenciador de estado de autenticação com Prisma

import { randomBytes } from 'crypto';
import { Curve } from '../crypto/Curve25519';
import { Logger } from '../utils/Logger';
import { Mutex } from 'async-mutex';
import { BufferJSON } from '../utils/BufferJSON';
import { prisma } from '../database/PrismaClient';

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
 * Gerenciador de estado de autenticação com Prisma
 */
export class AuthStateManager {
  private instanceId: string;
  
  // Cache em memória para as chaves
  private keysCache: Map<string, any> = new Map();
  private keysCacheLoaded: boolean = false;
  
  constructor(instanceId: string) {
    this.instanceId = instanceId;
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
    
    // Salva o estado inicial no banco
    await this.saveCreds(creds);
    
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
   * Salva as credenciais no banco
   */
  public async saveCreds(creds: AuthenticationCreds): Promise<void> {
    try {
      const serializedCreds = this.serializeCreds(creds);
      
      await prisma.instance.upsert({
        where: { instanceId: this.instanceId },
        update: {
          // Campos de credenciais individuais
          noiseKeyPrivate: Buffer.from(creds.noiseKey.private),
          noiseKeyPublic: Buffer.from(creds.noiseKey.public),
          pairingEphemeralKeyPrivate: Buffer.from(creds.pairingEphemeralKeyPair.private),
          pairingEphemeralKeyPublic: Buffer.from(creds.pairingEphemeralKeyPair.public),
          signedIdentityKeyPrivate: Buffer.from(creds.signedIdentityKey.private),
          signedIdentityKeyPublic: Buffer.from(creds.signedIdentityKey.public),
          signedPreKeyId: creds.signedPreKey.keyId,
          signedPreKeyPrivate: Buffer.from(creds.signedPreKey.keyPair.private),
          signedPreKeyPublic: Buffer.from(creds.signedPreKey.keyPair.public),
          signedPreKeySignature: Buffer.from(creds.signedPreKey.signature),
          registrationId: creds.registrationId,
          advSecretKey: creds.advSecretKey,
          nextPreKeyId: creds.nextPreKeyId,
          firstUnuploadedPreKeyId: creds.firstUnuploadedPreKeyId,
          serverHasPreKeys: creds.serverHasPreKeys,
          processedHistoryMessages: creds.processedHistoryMessages,
          accountSyncCounter: creds.accountSyncCounter,
          accountSettings: creds.accountSettings,
          registered: creds.registered,
          pairingCode: creds.pairingCode,
          lastPropHash: creds.lastPropHash,
          routingInfo: creds.routingInfo ? Buffer.from(creds.routingInfo) : null,
          userId: creds.me?.id || null,
          userName: creds.me?.name || null,
          userLid: creds.me?.lid || null,
          signalIdentities: creds.signalIdentities as any,
          myAppStateKeyId: creds.myAppStateKeyId,
          lastAccountSyncTimestamp: creds.lastAccountSyncTimestamp,
          platform: creds.platform,
          status: 'disconnected', // Status sempre inicia como disconnected, será atualizado quando conectar
          updatedAt: new Date()
        },
        create: {
          instanceId: this.instanceId,
          // Campos de credenciais individuais
          noiseKeyPrivate: Buffer.from(creds.noiseKey.private),
          noiseKeyPublic: Buffer.from(creds.noiseKey.public),
          pairingEphemeralKeyPrivate: Buffer.from(creds.pairingEphemeralKeyPair.private),
          pairingEphemeralKeyPublic: Buffer.from(creds.pairingEphemeralKeyPair.public),
          signedIdentityKeyPrivate: Buffer.from(creds.signedIdentityKey.private),
          signedIdentityKeyPublic: Buffer.from(creds.signedIdentityKey.public),
          signedPreKeyId: creds.signedPreKey.keyId,
          signedPreKeyPrivate: Buffer.from(creds.signedPreKey.keyPair.private),
          signedPreKeyPublic: Buffer.from(creds.signedPreKey.keyPair.public),
          signedPreKeySignature: Buffer.from(creds.signedPreKey.signature),
          registrationId: creds.registrationId,
          advSecretKey: creds.advSecretKey,
          nextPreKeyId: creds.nextPreKeyId,
          firstUnuploadedPreKeyId: creds.firstUnuploadedPreKeyId,
          serverHasPreKeys: creds.serverHasPreKeys,
          processedHistoryMessages: creds.processedHistoryMessages,
          accountSyncCounter: creds.accountSyncCounter,
          accountSettings: creds.accountSettings,
          registered: creds.registered,
          pairingCode: creds.pairingCode,
          lastPropHash: creds.lastPropHash,
          routingInfo: creds.routingInfo ? Buffer.from(creds.routingInfo) : null,
          userId: creds.me?.id || null,
          userName: creds.me?.name || null,
          userLid: creds.me?.lid || null,
          signalIdentities: creds.signalIdentities as any,
          myAppStateKeyId: creds.myAppStateKeyId,
          lastAccountSyncTimestamp: creds.lastAccountSyncTimestamp,
          platform: creds.platform,
          nameDevice: `BZap-${this.instanceId}`,
          numberDevice: creds.me?.id ? creds.me.id.split(':')[0] : null, // Extrai apenas a parte numérica
          webhookUrl: null,
          events: ['messages', 'connection'],
          createdAt: new Date(),
          updatedAt: new Date()
        }
      });
      
      Logger.debug(`💾 Credenciais salvas para: ${this.instanceId}`);
    } catch (error) {
      Logger.error(`❌ Erro ao salvar credenciais para ${this.instanceId}:`, error);
      throw error;
    }
  }
  
  /**
   * Carrega as credenciais do banco
   */
  public async loadCreds(): Promise<AuthenticationCreds | null> {
    try {
      const instance = await prisma.instance.findUnique({
        where: { instanceId: this.instanceId }
      });
      
      if (!instance || !instance.noiseKeyPrivate) {
        return null;
      }
      
      const creds = this.deserializeCredsFromInstance(instance);
      
      // ✅ Validar campos obrigatórios após pair-success
      if (creds.registered && (!creds.me || !creds.signalIdentities || !creds.platform)) {
        Logger.warn(`❌ Credenciais inválidas para ${this.instanceId}: campos obrigatórios ausentes após pair-success`);
        Logger.warn(`registered: ${creds.registered}, me: ${!!creds.me}, signalIdentities: ${!!creds.signalIdentities}, platform: ${!!creds.platform}`);
        return null; // Força novo QR
      }
      
      return creds;
    } catch (error) {
      Logger.error(`❌ Erro ao carregar credenciais para ${this.instanceId}:`, error);
      return null;
    }
  }

  /**
   * Carrega as chaves do banco para o cache
   */
  private async loadKeysToCache(): Promise<void> {
    if (this.keysCacheLoaded) return;
    
    try {
      // Carrega pre-keys
      const preKeys = await prisma.preKey.findMany({
        where: { instanceId: this.instanceId }
      });
      
      for (const preKey of preKeys) {
        this.keysCache.set(`pre-key:${preKey.keyId}`, {
          keyId: preKey.keyId,
          public: new Uint8Array(preKey.publicKey),
          private: new Uint8Array(preKey.privateKey)
        });
      }
      
      // Carrega sessions
      const sessions = await prisma.session.findMany({
        where: { instanceId: this.instanceId }
      });
      
      for (const session of sessions) {
        this.keysCache.set(`session:${session.sessionId}`, {
          id: session.sessionId,
          session: new Uint8Array(session.sessionData)
        });
      }
      
      // Carrega sender-keys
      const senderKeys = await prisma.senderKey.findMany({
        where: { instanceId: this.instanceId }
      });
      
      for (const senderKey of senderKeys) {
        const key = `${senderKey.groupId}:${senderKey.senderId}`;
        this.keysCache.set(`sender-key:${key}`, {
          groupId: senderKey.groupId,
          senderId: senderKey.senderId,
          senderKey: new Uint8Array(senderKey.senderKey)
        });
      }
      
      // Carrega app-state-sync-keys
      const appStateKeys = await prisma.appStateSyncKey.findMany({
        where: { instanceId: this.instanceId }
      });
      
      for (const appStateKey of appStateKeys) {
        this.keysCache.set(`app-state-sync-key:${appStateKey.keyId}`, {
          keyId: appStateKey.keyId,
          keyData: new Uint8Array(appStateKey.keyData)
        });
      }
      
      // Carrega app-state-sync-versions
      const appStateVersions = await prisma.appStateVersion.findMany({
        where: { instanceId: this.instanceId }
      });
      
      for (const version of appStateVersions) {
        this.keysCache.set(`app-state-sync-version:${version.name}`, {
          version: version.version,
          hash: version.hash ? new Uint8Array(version.hash) : new Uint8Array()
        });
      }
      
      this.keysCacheLoaded = true;
      Logger.debug(`🔑 Chaves carregadas do banco para: ${this.instanceId}`);
    } catch (error) {
      Logger.error(`❌ Erro ao carregar chaves para ${this.instanceId}:`, error);
    }
  }

  /**
   * Cria o store de chaves compatível com Baileys
   */
  private createKeysStore(): SignalKeyStore {
    return {
      get: async (type: string, ids: string[]) => {
        await this.loadKeysToCache();
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

  /**
   * Salva as chaves no banco com debounce
   */
  private saveKeysTimeout?: NodeJS.Timeout;
  private async debouncedSaveKeys(): Promise<void> {
    if (this.saveKeysTimeout) {
      clearTimeout(this.saveKeysTimeout);
    }
    this.saveKeysTimeout = setTimeout(async () => {
      await this.saveKeysToDatabase();
    }, 250);
  }

  /**
   * Persiste as chaves do cache no banco
   */
  private async saveKeysToDatabase(): Promise<void> {
    try {
      const operations: Promise<any>[] = [];
      
      for (const [key, value] of this.keysCache.entries()) {
        const [type, id] = key.split(':');
        
        switch (type) {
          case 'pre-key':
            if (value) {
              operations.push(
                prisma.preKey.upsert({
                  where: {
                    instanceId_keyId: {
                      instanceId: this.instanceId,
                      keyId: parseInt(id)
                    }
                  },
                  update: {
                    publicKey: Buffer.from(value.public),
                    privateKey: Buffer.from(value.private),
                    used: false
                  },
                  create: {
                    instanceId: this.instanceId,
                    keyId: parseInt(id),
                    publicKey: Buffer.from(value.public),
                    privateKey: Buffer.from(value.private),
                    used: false
                  }
                })
              );
            }
            break;
            
          case 'session':
            if (value) {
              operations.push(
                prisma.session.upsert({
                  where: {
                    instanceId_sessionId: {
                      instanceId: this.instanceId,
                      sessionId: id
                    }
                  },
                  update: {
                    sessionData: Buffer.from(value.session)
                  },
                  create: {
                    instanceId: this.instanceId,
                    sessionId: id,
                    sessionData: Buffer.from(value.session)
                  }
                })
              );
            }
            break;
            
          case 'sender-key':
            if (value) {
              const [groupId, senderId] = id.split(':');
              operations.push(
                prisma.senderKey.upsert({
                  where: {
                    instanceId_groupId_senderId: {
                      instanceId: this.instanceId,
                      groupId: groupId,
                      senderId: senderId
                    }
                  },
                  update: {
                    senderKey: Buffer.from(value.senderKey)
                  },
                  create: {
                    instanceId: this.instanceId,
                    groupId: groupId,
                    senderId: senderId,
                    senderKey: Buffer.from(value.senderKey)
                  }
                })
              );
            }
            break;
            
          case 'app-state-sync-key':
            if (value) {
              operations.push(
                prisma.appStateSyncKey.upsert({
                  where: {
                    instanceId_keyId: {
                      instanceId: this.instanceId,
                      keyId: id
                    }
                  },
                  update: {
                    keyData: Buffer.from(value.keyData)
                  },
                  create: {
                    instanceId: this.instanceId,
                    keyId: id,
                    keyData: Buffer.from(value.keyData)
                  }
                })
              );
            }
            break;
            
          case 'app-state-sync-version':
            if (value) {
              operations.push(
                prisma.appStateVersion.upsert({
                  where: {
                    instanceId_name: {
                      instanceId: this.instanceId,
                      name: id
                    }
                  },
                  update: {
                    version: value.version,
                    hash: Buffer.from(value.hash)
                  },
                  create: {
                    instanceId: this.instanceId,
                    name: id,
                    version: value.version,
                    hash: Buffer.from(value.hash)
                  }
                })
              );
            }
            break;
        }
      }
      
      if (operations.length > 0) {
        await Promise.all(operations);
        Logger.debug(`💾 ${operations.length} chaves salvas no banco para: ${this.instanceId}`);
      }
    } catch (error) {
      Logger.error(`❌ Erro ao salvar chaves no banco para ${this.instanceId}:`, error);
    }
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
      // Campos obrigatórios seguindo padrão Baileys
      processedHistoryMessages: creds.processedHistoryMessages || [],
      accountSyncCounter: creds.accountSyncCounter || 0,
      accountSettings: creds.accountSettings || { unarchiveChats: false },
      registered: creds.registered || false,
      // Campos opcionais mas importantes para persistência
      pairingCode: creds.pairingCode || null,
      lastPropHash: creds.lastPropHash || null,
      routingInfo: creds.routingInfo || null,
      account: creds.account || null,
      me: creds.me || null,
      signalIdentities: creds.signalIdentities || [],
      myAppStateKeyId: creds.myAppStateKeyId || null,
      lastAccountSyncTimestamp: creds.lastAccountSyncTimestamp || null,
      platform: creds.platform || null
    };
  }

  private deserializeCredsFromInstance(instance: any): AuthenticationCreds {
    return {
      noiseKey: {
        private: new Uint8Array(instance.noiseKeyPrivate),
        public: new Uint8Array(instance.noiseKeyPublic)
      },
      pairingEphemeralKeyPair: {
        private: new Uint8Array(instance.pairingEphemeralKeyPrivate),
        public: new Uint8Array(instance.pairingEphemeralKeyPublic)
      },
      signedIdentityKey: {
        private: new Uint8Array(instance.signedIdentityKeyPrivate),
        public: new Uint8Array(instance.signedIdentityKeyPublic)
      },
      signedPreKey: {
        keyId: instance.signedPreKeyId,
        keyPair: {
          private: new Uint8Array(instance.signedPreKeyPrivate),
          public: new Uint8Array(instance.signedPreKeyPublic)
        },
        signature: new Uint8Array(instance.signedPreKeySignature)
      },
      registrationId: instance.registrationId,
      advSecretKey: instance.advSecretKey,
      nextPreKeyId: instance.nextPreKeyId,
      firstUnuploadedPreKeyId: instance.firstUnuploadedPreKeyId,
      serverHasPreKeys: instance.serverHasPreKeys,
      processedHistoryMessages: instance.processedHistoryMessages || [],
      accountSyncCounter: instance.accountSyncCounter || 0,
      accountSettings: instance.accountSettings || { unarchiveChats: false },
      registered: instance.registered || false,
      pairingCode: instance.pairingCode || undefined,
      lastPropHash: instance.lastPropHash || undefined,
      routingInfo: instance.routingInfo ? new Uint8Array(instance.routingInfo) : undefined,
      me: instance.userId ? {
        id: instance.userId,
        name: instance.userName || undefined,
        lid: instance.userLid || undefined
      } : undefined,
      signalIdentities: instance.signalIdentities || undefined,
      myAppStateKeyId: instance.myAppStateKeyId || undefined,
      lastAccountSyncTimestamp: instance.lastAccountSyncTimestamp || undefined,
      platform: instance.platform || undefined
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
      pairingCode: data.pairingCode || undefined,
      lastPropHash: data.lastPropHash || undefined,
      routingInfo: data.routingInfo || undefined,
      account: data.account || undefined,
      me: data.me || undefined,
      signalIdentities: data.signalIdentities || undefined,
      myAppStateKeyId: data.myAppStateKeyId || undefined,
      lastAccountSyncTimestamp: data.lastAccountSyncTimestamp || undefined,
      platform: data.platform || undefined
    };
  }

  /**
   * Remove o estado de autenticação do banco
   */
  public async removeAuthState(): Promise<void> {
    try {
      // Remove todas as chaves relacionadas
      await Promise.all([
        prisma.preKey.deleteMany({ where: { instanceId: this.instanceId } }),
        prisma.session.deleteMany({ where: { instanceId: this.instanceId } }),
        prisma.senderKey.deleteMany({ where: { instanceId: this.instanceId } }),
        prisma.appStateSyncKey.deleteMany({ where: { instanceId: this.instanceId } }),
        prisma.appStateVersion.deleteMany({ where: { instanceId: this.instanceId } }),
        prisma.instance.delete({ where: { instanceId: this.instanceId } })
      ]);
      
      // Limpa o cache
      this.keysCache.clear();
      this.keysCacheLoaded = false;
      
      Logger.info(`🗑️ Sessão removida do banco: ${this.instanceId}`);
    } catch (error) {
      Logger.error(`❌ Erro ao remover sessão ${this.instanceId}:`, error);
    }
  }

  /**
   * Verifica se existe estado de autenticação
   */
  public async hasAuthState(): Promise<boolean> {
    try {
      const instance = await prisma.instance.findUnique({
        where: { instanceId: this.instanceId }
      });
      return !!instance;
    } catch (error) {
      Logger.error(`❌ Erro ao verificar estado de autenticação para ${this.instanceId}:`, error);
      return false;
    }
  }

  /**
   * Implementação do useMultiFileAuthState compatível com Baileys original
   * Agora usando Prisma em vez de arquivos
   */
  public async useMultiFileAuthState(): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }> {
    // Carrega ou inicializa credenciais
    const creds: AuthenticationCreds = (await this.loadCreds()) || this.initAuthCreds();
    
    return {
      state: {
        creds,
        keys: {
          get: async (type: string, ids: string[]) => {
            await this.loadKeysToCache();
            const data: { [id: string]: any } = {};
            
            for (const id of ids) {
              const value = this.keysCache.get(`${type}:${id}`);
              data[id] = value || null;
            }
            
            return data;
          },
          set: async (data: { [type: string]: { [id: string]: any } }) => {
            for (const category in data) {
              for (const id in data[category]) {
                const value = data[category][id];
                if (value) {
                  this.keysCache.set(`${category}:${id}`, value);
                } else {
                  this.keysCache.delete(`${category}:${id}`);
                }
              }
            }
            await this.debouncedSaveKeys();
          }
        }
      },
      saveCreds: async () => {
        return this.saveCreds(creds);
      }
    };
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
  
  /**
   * Cria estado de autenticação compatível com Baileys
   */
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

  /**
   * Atualiza credenciais parcialmente
   */
  public async updateCreds(credsUpdate: Partial<AuthenticationCreds>): Promise<void> {
    const existing = await this.loadCreds();
    if (!existing) return;
    const updated = { ...existing, ...credsUpdate } as AuthenticationCreds;
    await this.saveCreds(updated);
  }
}