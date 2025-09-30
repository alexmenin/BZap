import { randomBytes } from 'crypto';
import { Curve } from '../crypto/Curve25519';
import { Logger } from '../utils/Logger';
import { AuthStateManager, AuthenticationCreds, AuthenticationState } from './AuthStateManager';
import { prisma } from '../database/PrismaClient';

/**
 * Helper para adicionar prefixo 0x05 nas chaves públicas para envio ao servidor
 */
export const generateSignalPubKey = (pubKey: Uint8Array): Buffer => 
  pubKey.length === 33 ? Buffer.from(pubKey) : Buffer.concat([Buffer.from([0x05]), Buffer.from(pubKey)]);

export interface AuthCredentials {
  clientId?: string;
  deviceId?: number;
  noiseKey: KeyPair;
  pairingEphemeralKeyPair: KeyPair;
  pairingCode?: string;
  identityKey: KeyPair;
  signedIdentityKey: KeyPair;
  signedPreKey: SignedKeyPair;
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
  lastPropHash?: string;
  routingInfo?: Buffer;
  me?: {
    id: string;
    name?: string;
    lid?: string;
  };
  signalIdentities?: any[];
  myAppStateKeyId?: string;
  platform?: string;
}

export interface KeyPair {
  private: Uint8Array;
  public: Uint8Array;
}

export interface SignedKeyPair {
  keyPair: KeyPair;
  keyId: number;
  signature: Uint8Array;
}

export interface SessionData {
  instanceId: string;
  creds: AuthCredentials;
  keys: any; // Signal protocol keys
}

/**
 * Gerenciador de credenciais de autenticação compatível com Baileys usando Prisma
 */
export class CredentialsManager {
  private authStateManager: AuthStateManager | null = null;

  constructor() {
    // Logger é usado como classe estática
  }

  /**
   * Carrega credenciais do banco
   */
  public async loadCredentials(instanceId: string): Promise<AuthCredentials | null> {
    try {
      const instance = await prisma.instance.findUnique({
        where: { instanceId }
      });

      if (!instance) {
        Logger.debug(`🔍 Nenhuma credencial encontrada para: ${instanceId}`);
        return null;
      }

      // Reconstrói as credenciais a partir dos campos individuais
        const credentials: AuthCredentials = {
          noiseKey: {
            private: instance.noiseKeyPrivate || new Uint8Array(),
            public: instance.noiseKeyPublic || new Uint8Array()
          },
          pairingEphemeralKeyPair: {
            private: instance.pairingEphemeralKeyPrivate || new Uint8Array(),
            public: instance.pairingEphemeralKeyPublic || new Uint8Array()
          },
          signedIdentityKey: {
            private: instance.signedIdentityKeyPrivate || new Uint8Array(),
            public: instance.signedIdentityKeyPublic || new Uint8Array()
          },
          identityKey: {
            private: instance.signedIdentityKeyPrivate || new Uint8Array(),
            public: instance.signedIdentityKeyPublic || new Uint8Array()
          },
          signedPreKey: {
            keyId: instance.signedPreKeyId || 0,
            keyPair: {
              private: instance.signedPreKeyPrivate || new Uint8Array(),
              public: instance.signedPreKeyPublic || new Uint8Array()
            },
            signature: instance.signedPreKeySignature || new Uint8Array()
          },
          registrationId: instance.registrationId || 0,
          advSecretKey: instance.advSecretKey || '',
          nextPreKeyId: instance.nextPreKeyId,
          firstUnuploadedPreKeyId: instance.firstUnuploadedPreKeyId,
          processedHistoryMessages: (instance.processedHistoryMessages as any[]) || [],
          accountSyncCounter: instance.accountSyncCounter,
          accountSettings: (instance.accountSettings as { unarchiveChats: boolean }) || { unarchiveChats: false },
          registered: instance.registered,
          pairingCode: instance.pairingCode || undefined,
          lastPropHash: instance.lastPropHash || undefined,
          routingInfo: instance.routingInfo ? Buffer.from(instance.routingInfo) : undefined,
          me: instance.userId ? {
            id: instance.userId,
            name: instance.userName || undefined,
            lid: instance.userLid || undefined
          } : undefined,
          signalIdentities: (instance.signalIdentities as any) || [],
          myAppStateKeyId: instance.myAppStateKeyId || undefined,
          platform: instance.platform || undefined
        };

      Logger.debug(`✅ Credenciais carregadas do banco para: ${instanceId}`);
      return credentials;
    } catch (error) {
      Logger.error(`❌ Erro ao carregar credenciais para ${instanceId}:`, error);
      return null;
    }
  }

  /**
   * Cria novas credenciais usando padrão Baileys
   */
  public async createCredentials(instanceId: string): Promise<AuthCredentials> {
    this.authStateManager = new AuthStateManager(instanceId);
    const { state } = await this.authStateManager.useMultiFileAuthState();
    
    // Converte credenciais do Baileys para formato interno se necessário
    const credentials = this.convertBaileysCredsToInternal(state.creds);
    
    // Salva no banco
    await this.saveCredentials(instanceId, credentials);
    
    return credentials;
  }
  
  /**
   * Obtém estado de autenticação Baileys para uma instância
   */
  public async getBaileysAuthState(instanceId: string): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }> {
    if (!this.authStateManager || this.authStateManager['instanceId'] !== instanceId) {
      this.authStateManager = new AuthStateManager(instanceId);
    }
    return await this.authStateManager.useMultiFileAuthState();
  }

  /**
   * Converte credenciais do Baileys para formato interno
   */
  private convertBaileysCredsToInternal(creds: AuthenticationCreds): AuthCredentials {
    return {
      clientId: undefined,
      deviceId: undefined,
      noiseKey: creds.noiseKey,
      pairingEphemeralKeyPair: creds.pairingEphemeralKeyPair,
      pairingCode: creds.pairingCode,
      identityKey: creds.signedIdentityKey, // Usando signedIdentityKey como identityKey
      signedIdentityKey: creds.signedIdentityKey,
      signedPreKey: creds.signedPreKey,
      registrationId: creds.registrationId,
      advSecretKey: creds.advSecretKey,
      processedHistoryMessages: creds.processedHistoryMessages || [],
      nextPreKeyId: creds.nextPreKeyId,
      firstUnuploadedPreKeyId: creds.firstUnuploadedPreKeyId,
      accountSyncCounter: creds.accountSyncCounter,
      accountSettings: creds.accountSettings,
      registered: creds.registered,
      lastPropHash: creds.lastPropHash,
      routingInfo: creds.routingInfo ? Buffer.from(creds.routingInfo as any) : undefined,
      me: creds.me,
      signalIdentities: creds.signalIdentities,
      myAppStateKeyId: creds.myAppStateKeyId,
      platform: creds.platform
    };
  }

  /**
   * Inicializa novas credenciais seguindo padrão Baileys
   */
  public initAuthCreds(): AuthCredentials {
    const identityKey = Curve.generateKeyPair();
    const noiseKey = Curve.generateKeyPair();
    const pairingEphemeralKeyPair = Curve.generateKeyPair();
    const signedPreKey = this.generateSignedPreKey(identityKey, 1);
    const registrationId = this.generateRegistrationId();

    return {
      clientId: undefined,
      deviceId: undefined,
      noiseKey,
      pairingEphemeralKeyPair,
      identityKey,
      signedIdentityKey: identityKey,
      signedPreKey,
      registrationId,
      advSecretKey: randomBytes(32).toString('base64'),
      processedHistoryMessages: [],
      nextPreKeyId: 1,
      firstUnuploadedPreKeyId: 1,
      accountSyncCounter: 0,
      accountSettings: {
        unarchiveChats: false
      },
      registered: false,
      lastPropHash: undefined,
      routingInfo: undefined,
      me: undefined,
      signalIdentities: [],
      myAppStateKeyId: undefined,
      platform: undefined
    };
  }

  /**
   * Gera ID de registro aleatório
   */
  private generateRegistrationId(): number {
    return Uint16Array.from(randomBytes(2))[0]! & 16383;
  }

  private generateSignedPreKey(identityKeyPair: any, keyId: number): SignedKeyPair {
    const preKey = Curve.generateKeyPair();
    const pubKey = generateSignalPubKey(preKey.public);
    const signature = Curve.sign(identityKeyPair.private, pubKey);
    
    return {
      keyId,
      keyPair: preKey,
      signature
    };
  }

  /**
   * Salva credenciais no banco
   */
  public async saveCredentials(instanceId: string, credentials: AuthCredentials): Promise<void> {
    try {
      await prisma.instance.upsert({
        where: { instanceId },
        update: {
          noiseKeyPrivate: Buffer.from(credentials.noiseKey.private),
          noiseKeyPublic: Buffer.from(credentials.noiseKey.public),
          pairingEphemeralKeyPrivate: Buffer.from(credentials.pairingEphemeralKeyPair.private),
          pairingEphemeralKeyPublic: Buffer.from(credentials.pairingEphemeralKeyPair.public),
          signedIdentityKeyPrivate: Buffer.from(credentials.signedIdentityKey.private),
          signedIdentityKeyPublic: Buffer.from(credentials.signedIdentityKey.public),
          signedPreKeyId: credentials.signedPreKey.keyId,
          signedPreKeyPrivate: Buffer.from(credentials.signedPreKey.keyPair.private),
          signedPreKeyPublic: Buffer.from(credentials.signedPreKey.keyPair.public),
          signedPreKeySignature: Buffer.from(credentials.signedPreKey.signature),
          registrationId: credentials.registrationId,
          advSecretKey: credentials.advSecretKey,
          nextPreKeyId: credentials.nextPreKeyId,
          firstUnuploadedPreKeyId: credentials.firstUnuploadedPreKeyId,
          processedHistoryMessages: credentials.processedHistoryMessages,
          accountSyncCounter: credentials.accountSyncCounter,
          accountSettings: credentials.accountSettings,
          registered: credentials.registered,
          pairingCode: credentials.pairingCode || null,
          lastPropHash: credentials.lastPropHash || null,
          routingInfo: credentials.routingInfo ? Buffer.from(credentials.routingInfo) : null,
          userId: credentials.me?.id || null,
          userName: credentials.me?.name || null,
          userLid: credentials.me?.lid || null,
          signalIdentities: credentials.signalIdentities || [],
          myAppStateKeyId: credentials.myAppStateKeyId || null,
          platform: credentials.platform || null,
          status: 'disconnected', // Status sempre inicia como disconnected, será atualizado quando conectar
          numberDevice: credentials.me?.id ? credentials.me.id.split(':')[0] : null, // Extrai apenas a parte numérica
          updatedAt: new Date()
        },
        create: {
          instanceId,
          noiseKeyPrivate: Buffer.from(credentials.noiseKey.private),
          noiseKeyPublic: Buffer.from(credentials.noiseKey.public),
          pairingEphemeralKeyPrivate: Buffer.from(credentials.pairingEphemeralKeyPair.private),
          pairingEphemeralKeyPublic: Buffer.from(credentials.pairingEphemeralKeyPair.public),
          signedIdentityKeyPrivate: Buffer.from(credentials.signedIdentityKey.private),
          signedIdentityKeyPublic: Buffer.from(credentials.signedIdentityKey.public),
          signedPreKeyId: credentials.signedPreKey.keyId,
          signedPreKeyPrivate: Buffer.from(credentials.signedPreKey.keyPair.private),
          signedPreKeyPublic: Buffer.from(credentials.signedPreKey.keyPair.public),
          signedPreKeySignature: Buffer.from(credentials.signedPreKey.signature),
          registrationId: credentials.registrationId,
          advSecretKey: credentials.advSecretKey,
          nextPreKeyId: credentials.nextPreKeyId,
          firstUnuploadedPreKeyId: credentials.firstUnuploadedPreKeyId,
          processedHistoryMessages: credentials.processedHistoryMessages,
          accountSyncCounter: credentials.accountSyncCounter,
          accountSettings: credentials.accountSettings,
          registered: credentials.registered,
          pairingCode: credentials.pairingCode || null,
          lastPropHash: credentials.lastPropHash || null,
          routingInfo: credentials.routingInfo ? Buffer.from(credentials.routingInfo) : null,
          userId: credentials.me?.id || null,
          userName: credentials.me?.name || null,
          userLid: credentials.me?.lid || null,
          signalIdentities: credentials.signalIdentities || [],
          myAppStateKeyId: credentials.myAppStateKeyId || null,
          platform: credentials.platform || null,
          status: 'disconnected', // Status sempre inicia como disconnected, será atualizado quando conectar
          nameDevice: `BZap-${instanceId}`,
          numberDevice: credentials.me?.id ? credentials.me.id.split(':')[0] : null, // Extrai apenas a parte numérica
          webhookUrl: null,
          events: ['messages', 'connection'],
          createdAt: new Date(),
          updatedAt: new Date()
        }
      });

      Logger.debug(`💾 Credenciais salvas no banco para: ${instanceId}`);
    } catch (error) {
      Logger.error(`❌ Erro ao salvar credenciais para ${instanceId}:`, error);
      throw error;
    }
  }

  /**
   * Salva sessão completa no banco (compatibilidade)
   */
  public async saveSession(instanceId: string, sessionData: SessionData): Promise<void> {
    try {
      await this.saveCredentials(instanceId, sessionData.creds);
      Logger.debug(`💾 Sessão salva no banco para: ${instanceId}`);
    } catch (error) {
      Logger.error(`❌ Erro ao salvar sessão para ${instanceId}:`, error);
      throw error;
    }
  }

  /**
   * Carrega sessão completa do banco (compatibilidade)
   */
  public async loadSession(instanceId: string): Promise<SessionData | null> {
    try {
      const credentials = await this.loadCredentials(instanceId);
      if (!credentials) {
        return null;
      }

      return this.createSessionData(instanceId, credentials);
    } catch (error) {
      Logger.error(`❌ Erro ao carregar sessão para ${instanceId}:`, error);
      return null;
    }
  }

  /**
   * Remove sessão do banco
   */
  public async removeSession(instanceId: string): Promise<void> {
    try {
      // Remove todas as chaves relacionadas
      await Promise.all([
        prisma.preKey.deleteMany({ where: { instanceId } }),
        prisma.session.deleteMany({ where: { instanceId } }),
        prisma.senderKey.deleteMany({ where: { instanceId } }),
        prisma.appStateSyncKey.deleteMany({ where: { instanceId } }),
        prisma.appStateVersion.deleteMany({ where: { instanceId } }),
        prisma.instance.delete({ where: { instanceId } })
      ]);

      Logger.info(`🗑️ Sessão removida do banco: ${instanceId}`);
    } catch (error) {
      Logger.error(`❌ Erro ao remover sessão ${instanceId}:`, error);
    }
  }

  /**
   * Verifica se existe sessão no banco
   */
  public async hasSession(instanceId: string): Promise<boolean> {
     try {
       const instance = await prisma.instance.findUnique({
         where: { instanceId }
       });
       
       if (!instance) {
         return false;
       }
       
       // ✅ CORREÇÃO: Verifica se as credenciais são realmente válidas
       // Não basta apenas existir no banco, precisa ter dados completos de autenticação
       
       // Verifica se tem chaves básicas
       if (!instance.noiseKeyPrivate || !instance.signedIdentityKeyPrivate) {
         Logger.debug(`🔍 Instância ${instanceId} existe mas não tem chaves básicas`);
         return false;
       }
       
       // Verifica se está registrado e tem informações de usuário
       if (!instance.registered || !instance.userId) {
         Logger.debug(`🔍 Instância ${instanceId} existe mas não está registrada ou não tem userId`);
         return false;
       }
       
       // Verifica se tem platform (obrigatório após pair-success)
       if (!instance.platform) {
         Logger.debug(`🔍 Instância ${instanceId} existe mas não tem platform definido`);
         return false;
       }
       
       Logger.debug(`✅ Instância ${instanceId} tem sessão válida`);
       return true;
     } catch (error) {
       Logger.error(`❌ Erro ao verificar sessão para ${instanceId}:`, error);
       return false;
     }
   }

  /**
   * Cria dados de sessão
   */
  private createSessionData(instanceId: string, creds: AuthCredentials): SessionData {
    return {
      instanceId,
      creds,
      keys: {} // Chaves serão gerenciadas pelo AuthStateManager
    };
  }

  /**
   * Serializa credenciais para armazenamento
   */
  private serializeCredentials(creds: AuthCredentials): any {
    return {
      clientId: creds.clientId || null,
      deviceId: creds.deviceId || null,
      noiseKey: {
        private: Buffer.from(creds.noiseKey.private).toString('base64'),
        public: Buffer.from(creds.noiseKey.public).toString('base64')
      },
      pairingEphemeralKeyPair: {
        private: Buffer.from(creds.pairingEphemeralKeyPair.private).toString('base64'),
        public: Buffer.from(creds.pairingEphemeralKeyPair.public).toString('base64')
      },
      pairingCode: creds.pairingCode || null,
      identityKey: {
        private: Buffer.from(creds.identityKey.private).toString('base64'),
        public: Buffer.from(creds.identityKey.public).toString('base64')
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
      processedHistoryMessages: creds.processedHistoryMessages || [],
      nextPreKeyId: creds.nextPreKeyId,
      firstUnuploadedPreKeyId: creds.firstUnuploadedPreKeyId,
      accountSyncCounter: creds.accountSyncCounter,
      accountSettings: creds.accountSettings,
      registered: creds.registered,
      lastPropHash: creds.lastPropHash || null,
      routingInfo: creds.routingInfo ? Buffer.from(creds.routingInfo).toString('base64') : null,
      me: creds.me || null,
      signalIdentities: creds.signalIdentities || [],
      myAppStateKeyId: creds.myAppStateKeyId || null,
      platform: creds.platform || null
    };
  }

  /**
   * Deserializa credenciais do armazenamento
   */
  private deserializeCredentials(data: any): AuthCredentials {
    const parseKeyPair = (obj: any): KeyPair => ({
      private: Buffer.from(obj.private, 'base64'),
      public: Buffer.from(obj.public, 'base64')
    });

    const parseSignedPreKey = (obj: any): SignedKeyPair => ({
      keyId: obj.keyId,
      keyPair: {
        private: Buffer.from(obj.private, 'base64'),
        public: Buffer.from(obj.public, 'base64')
      },
      signature: Buffer.from(obj.signature, 'base64')
    });

    return {
      clientId: data.clientId || undefined,
      deviceId: data.deviceId || undefined,
      noiseKey: parseKeyPair(data.noiseKey),
      pairingEphemeralKeyPair: parseKeyPair(data.pairingEphemeralKeyPair),
      pairingCode: data.pairingCode || undefined,
      identityKey: parseKeyPair(data.identityKey),
      signedIdentityKey: parseKeyPair(data.signedIdentityKey),
      signedPreKey: parseSignedPreKey(data.signedPreKey),
      registrationId: data.registrationId,
      advSecretKey: data.advSecretKey,
      processedHistoryMessages: data.processedHistoryMessages || [],
      nextPreKeyId: data.nextPreKeyId,
      firstUnuploadedPreKeyId: data.firstUnuploadedPreKeyId,
      accountSyncCounter: data.accountSyncCounter,
      accountSettings: data.accountSettings,
      registered: data.registered,
      lastPropHash: data.lastPropHash || undefined,
      routingInfo: data.routingInfo ? Buffer.from(data.routingInfo, 'base64') : undefined,
      me: data.me || undefined,
      signalIdentities: data.signalIdentities || [],
      myAppStateKeyId: data.myAppStateKeyId || undefined,
      platform: data.platform || undefined
    };
  }

  /**
   * Atualiza credenciais após emparelhamento
   */
  public updateCredentialsAfterPairing(creds: AuthCredentials, jid: string, displayName?: string): void {
    creds.registered = true;
    creds.me = {
      id: jid,
      name: displayName,
      lid: undefined
    };
    
    // Atualiza platform se não estiver definido
    if (!creds.platform) {
      creds.platform = 'web';
    }
    
    Logger.info(`✅ Credenciais atualizadas após emparelhamento: ${jid}`);
  }

  /**
   * Atualiza credenciais parcialmente
   */
  public async updateCredentials(instanceId: string, credsUpdate: Partial<AuthCredentials>): Promise<void> {
    const existing = await this.loadCredentials(instanceId);
    if (!existing) return;
    
    const updated = { ...existing, ...credsUpdate } as AuthCredentials;
    await this.saveCredentials(instanceId, updated);
  }

  /**
   * Lista todas as instâncias no banco
   */
  public async listInstances(): Promise<string[]> {
    try {
      const instances = await prisma.instance.findMany({
        select: { instanceId: true }
      });
      return instances.map(instance => instance.instanceId);
    } catch (error) {
      Logger.error('❌ Erro ao listar instâncias:', error);
      return [];
    }
  }

  /**
   * Obtém informações da instância
   */
  public async getInstanceInfo(instanceId: string): Promise<any> {
    try {
      const instance = await prisma.instance.findUnique({
        where: { instanceId },
        select: {
          instanceId: true,
          registered: true,
          status: true,
          nameDevice: true,
          numberDevice: true,
          webhookUrl: true,
          events: true,
          createdAt: true,
          updatedAt: true
        }
      });
      return instance;
    } catch (error) {
      Logger.error(`❌ Erro ao obter informações da instância ${instanceId}:`, error);
      return null;
    }
  }
}