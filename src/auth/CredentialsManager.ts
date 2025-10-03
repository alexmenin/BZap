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
  private: Buffer;
  public: Buffer;
}

export interface SignedKeyPair {
  keyPair: KeyPair;
  keyId: number;
  signature: Buffer;
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
      const cred = await prisma.credential.findUnique({
        where: { instanceId }
      });

      if (!cred) {
        Logger.debug(`🔍 Nenhuma credencial encontrada para: ${instanceId}`);
        return null;
      }

      // Função helper para validar e criar Buffer de chave
      const createKeyBuffer = (data: any, expectedSize: number, keyName: string): Buffer => {
        if (!data) {
          Logger.warn(`⚠️ ${keyName} não encontrada, criando buffer vazio`);
          return Buffer.alloc(expectedSize);
        }
        
        // Se já é Buffer, verifica tamanho
        if (Buffer.isBuffer(data)) {
          if (data.length !== expectedSize) {
            Logger.warn(`⚠️ ${keyName} com tamanho incorreto: ${data.length} bytes (esperado: ${expectedSize})`);
          }
          return data;
        }
        
        // Se é Uint8Array, converte para Buffer
        if (data instanceof Uint8Array) {
          const buffer = Buffer.from(data);
          if (buffer.length !== expectedSize) {
            Logger.warn(`⚠️ ${keyName} com tamanho incorreto após conversão: ${buffer.length} bytes (esperado: ${expectedSize})`);
          }
          return buffer;
        }
        
        // Se é string base64, converte para Buffer
        try {
          const buffer = Buffer.from(data.toString(), 'base64');
          if (buffer.length !== expectedSize) {
            Logger.warn(`⚠️ ${keyName} com tamanho incorreto após conversão: ${buffer.length} bytes (esperado: ${expectedSize})`);
          }
          return buffer;
        } catch (error) {
          Logger.error(`❌ Erro ao converter ${keyName} de base64:`, error);
          return Buffer.alloc(expectedSize);
        }
      };

      // Helpers para parse de JSON armazenado em credentials
      const parseKeyPair = (jsonStr: string | null | undefined, keyName: string) => {
        try {
          if (!jsonStr) return { private: Buffer.alloc(32), public: Buffer.alloc(32) };
          const obj = JSON.parse(jsonStr);
          return {
            private: createKeyBuffer(obj?.private, 32, `${keyName}.private`),
            public: createKeyBuffer(obj?.public, 32, `${keyName}.public`)
          };
        } catch (e) {
          Logger.warn(`⚠️ Erro ao parsear ${keyName} de credentials:`, e);
          return { private: Buffer.alloc(32), public: Buffer.alloc(32) };
        }
      };

      const noiseKeyPair = parseKeyPair(cred.noiseKey, 'noiseKey');
      const identityKeyPair = parseKeyPair(cred.identityKey, 'identityKey');

      // Reconstrói as credenciais com validação de tamanho a partir da tabela 'credentials'
      const credentials: AuthCredentials = {
        noiseKey: noiseKeyPair,
        pairingEphemeralKeyPair: {
          // Campos não persistidos no novo schema; inicializa com buffers vazios
          private: Buffer.alloc(32),
          public: Buffer.alloc(32)
        },
        signedIdentityKey: identityKeyPair,
        identityKey: identityKeyPair,
        signedPreKey: {
          keyId: cred.signedPreKeyId || 0,
          keyPair: {
            private: createKeyBuffer(cred.signedPreKeyPriv, 32, 'signedPreKey.private'),
            public: createKeyBuffer(cred.signedPreKeyPub, 32, 'signedPreKey.public')
          },
          signature: createKeyBuffer(cred.signedPreKeySig, 64, 'signedPreKey.signature')
        },
        registrationId: cred.registrationId || 0,
        advSecretKey: cred.advSecretKey || '',
        nextPreKeyId: 1,
        firstUnuploadedPreKeyId: 1,
        processedHistoryMessages: [],
        accountSyncCounter: 0,
        accountSettings: { unarchiveChats: false },
        registered: !!cred.signedPreKeyId,
        pairingCode: undefined,
        lastPropHash: undefined,
        routingInfo: undefined,
        me: undefined,
        signalIdentities: [],
        myAppStateKeyId: undefined,
        platform: undefined
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
    const { state } = await this.authStateManager.useMultiFileAuthState(instanceId);
    
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
    return await this.authStateManager.useMultiFileAuthState(instanceId);
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
      signature: Buffer.from(signature)
    };
  }

  /**
   * Salva credenciais no banco
   */
  public async saveCredentials(instanceId: string, credentials: AuthCredentials): Promise<void> {
    try {
      // Novo schema: salva credenciais na tabela 'credentials'
      const noiseKeyStr = JSON.stringify({
        private: Buffer.from(credentials.noiseKey.private).toString('base64'),
        public: Buffer.from(credentials.noiseKey.public).toString('base64')
      });
      const identityKeyStr = JSON.stringify({
        private: Buffer.from(credentials.signedIdentityKey.private).toString('base64'),
        public: Buffer.from(credentials.signedIdentityKey.public).toString('base64')
      });

      await prisma.credential.upsert({
        where: { instanceId },
        update: {
          registrationId: credentials.registrationId,
          noiseKey: noiseKeyStr,
          identityKey: identityKeyStr,
          advSecretKey: credentials.advSecretKey || null,
          signedPreKeyId: credentials.signedPreKey?.keyId ?? null,
          signedPreKeyPub: credentials.signedPreKey?.keyPair?.public
            ? Buffer.from(credentials.signedPreKey.keyPair.public).toString('base64')
            : null,
          signedPreKeyPriv: credentials.signedPreKey?.keyPair?.private
            ? Buffer.from(credentials.signedPreKey.keyPair.private).toString('base64')
            : null,
          signedPreKeySig: credentials.signedPreKey?.signature
            ? Buffer.from(credentials.signedPreKey.signature).toString('base64')
            : null,
          updatedAt: new Date()
        },
        create: {
          instanceId,
          registrationId: credentials.registrationId,
          noiseKey: noiseKeyStr,
          identityKey: identityKeyStr,
          advSecretKey: credentials.advSecretKey || null,
          signedPreKeyId: credentials.signedPreKey?.keyId ?? null,
          signedPreKeyPub: credentials.signedPreKey?.keyPair?.public
            ? Buffer.from(credentials.signedPreKey.keyPair.public).toString('base64')
            : null,
          signedPreKeyPriv: credentials.signedPreKey?.keyPair?.private
            ? Buffer.from(credentials.signedPreKey.keyPair.private).toString('base64')
            : null,
          signedPreKeySig: credentials.signedPreKey?.signature
            ? Buffer.from(credentials.signedPreKey.signature).toString('base64')
            : null,
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
        prisma.appStateKey.deleteMany({ where: { instanceId } }),
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
       // Novo schema: verificação baseada em credentials
       const cred = await prisma.credential.findUnique({
         where: { instanceId }
       });

       if (!cred) {
         Logger.debug(`🔍 Instância ${instanceId} não possui registro em credentials`);
         return false;
       }

       // Verifica se tem chaves básicas
       if (!cred.noiseKey || !cred.identityKey) {
         Logger.debug(`🔍 Instância ${instanceId} possui credentials incompletas (noiseKey/identityKey ausentes)`);
         return false;
       }

       // Verifica se existe SignedPreKey configurada (opcional, mas recomendado após pareamento)
       if (!cred.signedPreKeyId || !cred.signedPreKeyPriv || !cred.signedPreKeyPub || !cred.signedPreKeySig) {
         Logger.debug(`🔍 Instância ${instanceId} ainda não possui SignedPreKey ativa completa`);
         // não retornamos false, pode estar em processo de configuração
       }

       Logger.debug(`✅ Instância ${instanceId} possui credentials válidas`);
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
    const parseKeyPair = (obj: any): KeyPair => {
      const privateKey = Buffer.from(obj.private, 'base64');
      const publicKey = Buffer.from(obj.public, 'base64');
      
      // Validação de tamanho das chaves (32 bytes para Curve25519)
      if (privateKey.length !== 32) {
        Logger.warn(`⚠️ Chave privada com tamanho incorreto: ${privateKey.length} bytes (esperado: 32)`);
      }
      if (publicKey.length !== 32) {
        Logger.warn(`⚠️ Chave pública com tamanho incorreto: ${publicKey.length} bytes (esperado: 32)`);
      }
      
      return {
        private: privateKey,
        public: publicKey
      };
    };

    const parseSignedPreKey = (obj: any): SignedKeyPair => {
      const privateKey = Buffer.from(obj.private, 'base64');
      const publicKey = Buffer.from(obj.public, 'base64');
      const signature = Buffer.from(obj.signature, 'base64');
      
      // Validação de tamanho das chaves
      if (privateKey.length !== 32) {
        Logger.warn(`⚠️ SignedPreKey privada com tamanho incorreto: ${privateKey.length} bytes (esperado: 32)`);
      }
      if (publicKey.length !== 32) {
        Logger.warn(`⚠️ SignedPreKey pública com tamanho incorreto: ${publicKey.length} bytes (esperado: 32)`);
      }
      if (signature.length !== 64) {
        Logger.warn(`⚠️ Assinatura com tamanho incorreto: ${signature.length} bytes (esperado: 64)`);
      }
      
      return {
        keyId: obj.keyId,
        keyPair: {
          private: privateKey,
          public: publicKey
        },
        signature: signature
      };
    };

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